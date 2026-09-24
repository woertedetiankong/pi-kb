import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { chunkPages } from "./chunk.ts";
import { type KbConfig, loadConfig, saveConfig } from "./config.ts";
import { type ConvertedPage, Converter, isMarkdown, normalizeText, sourceKind } from "./convert.ts";
import { type Note, normalizeTags, now, parseNote, renderNote, slugify, today } from "./notes.ts";
import { type Collection, type DocRecord, type SearchHit, Store } from "./store.ts";

export interface NoteInput {
	title: string;
	content: string;
	tags?: string[];
	project?: string;
}

export type NoteMode = "create" | "append" | "replace";

/** A note ready to be written; built first so the user can review it. */
export interface PreparedNote {
	action: NoteMode;
	file: string;
	note: Note;
	/** Existing note being updated, for append and replace. */
	existing?: DocRecord;
}

/** Known failure reasons, so the interface can explain them in the user's language. */
export type AddReason = "not_found" | "unsupported" | "no_text" | "not_markdown" | "needs_libreoffice";

export interface AddResult {
	path: string;
	status: "added" | "exists" | "skipped" | "failed";
	doc?: DocRecord;
	reason?: AddReason;
	/** English detail for the model and for unexpected errors. */
	message?: string;
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const PAGE_MARK = /^<!-- kb:page (\d+) -->$/m;
/** Files kept in the wiki folder for navigation and history rather than as knowledge. */
const WIKI_META = new Set(["index.md", "log.md", "SCHEMA.md"]);

export function expandHome(path: string): string {
	return path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function formatCitation(hit: Pick<SearchHit, "title" | "page">): string {
	return hit.page ? `[${hit.title} p.${hit.page}]` : `[${hit.title}]`;
}

/**
 * The knowledge base on disk:
 *   raw/<id>/<file>     untouched copy of each imported file
 *   converted/<id>.md   searchable Markdown with <!-- kb:page N --> markers
 *   wiki/**.md          notes and experience written by people or the agent
 *   kb.db               SQLite FTS5 (trigram) index over both
 */
export class KnowledgeBase {
	readonly store: Store;
	readonly converter: Converter;
	readonly root: string;
	config: KbConfig;

	constructor(root: string) {
		this.root = root;
		for (const dir of ["raw", "converted", "wiki"]) mkdirSync(join(root, dir), { recursive: true });
		this.config = loadConfig(root);
		this.store = new Store(join(root, "kb.db"));
		this.converter = new Converter({
			ocrLanguage: this.config.ocrLanguage,
			tessdataDir: process.env.PI_KB_TESSDATA || join(root, "tessdata"),
			ocrServerUrl: this.config.ocrServerUrl,
		});
	}

	get wikiDir(): string {
		return join(this.root, "wiki");
	}

	updateConfig(change: Partial<KbConfig>): void {
		this.config = { ...this.config, ...change };
		saveConfig(this.root, this.config);
	}

	close(): void {
		this.converter.close();
		this.store.close();
	}

	/** Expand files and directories (recursively, skipping hidden and dependency folders) into importable files. */
	collectFiles(inputs: string[], cwd: string): { files: string[]; skipped: AddResult[] } {
		const files: string[] = [];
		const skipped: AddResult[] = [];
		const visit = (path: string, explicit: boolean) => {
			let info: ReturnType<typeof statSync>;
			try {
				info = statSync(path);
			} catch {
				skipped.push({ path, status: "failed", reason: "not_found", message: "not found" });
				return;
			}
			if (info.isDirectory()) {
				for (const entry of readdirSync(path).sort()) {
					if (entry.startsWith(".") || entry === "node_modules") continue;
					visit(join(path, entry), false);
				}
			} else if (sourceKind(path)) {
				files.push(path);
			} else if (explicit) {
				skipped.push({ path, status: "skipped", reason: "unsupported", message: `unsupported type ${extname(path) || "(none)"}` });
			}
		};
		for (const input of inputs) visit(resolve(cwd, expandHome(input)), true);
		return { files, skipped };
	}

	/**
	 * Import one file. Documents are converted and indexed; Markdown sent with
	 * `wiki: true` is copied into the wiki folder as a note instead.
	 */
	async addFile(path: string, options: { wiki?: boolean } = {}): Promise<AddResult> {
		try {
			if (options.wiki) {
				if (!isMarkdown(path)) return { path, status: "skipped", reason: "not_markdown", message: "only Markdown files can become wiki notes" };
				return this.addWikiFile(path);
			}
			const bytes = readFileSync(path);
			const hash = sha(bytes);
			const id = `k-${hash.slice(0, 12)}`;
			const existing = this.store.getDoc(id);
			if (existing) return { path, status: "exists", doc: existing };

			const converted = await this.converter.convert(path);
			const text = converted.pages.map((p) => p.markdown).join("");
			if (!text.trim()) return { path, status: "failed", reason: "no_text", message: "no text could be extracted" };

			const name = basename(path);
			mkdirSync(join(this.root, "raw", id), { recursive: true });
			copyFileSync(path, join(this.root, "raw", id, name));
			const rel = join("converted", `${id}.md`);
			writeFileSync(join(this.root, rel), renderConverted(name, converted.pages));

			const paged = converted.pages.some((p) => p.page !== null);
			const doc: DocRecord = {
				id,
				title: name,
				collection: "docs",
				kind: converted.kind,
				source: path,
				path: rel,
				pages: paged ? converted.pages.length : null,
				chars: text.length,
				hash,
				added_at: new Date().toISOString(),
			};
			this.store.putDoc(doc, chunkPages(converted.pages));
			return { path, status: "added", doc };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { path, status: "failed", reason: /LibreOffice/.test(message) ? "needs_libreoffice" : undefined, message };
		}
	}

	private addWikiFile(path: string): AddResult {
		const content = readFileSync(path, "utf8");
		let target = join(this.wikiDir, basename(path));
		if (existsSync(target) && readFileSync(target, "utf8") !== content) {
			const stem = basename(path, extname(path));
			for (let n = 2; existsSync(target); n++) target = join(this.wikiDir, `${stem}-${n}${extname(path)}`);
		}
		writeFileSync(target, content);
		const doc = this.indexWikiFile(target);
		return { path, status: "added", doc };
	}

	/** Index (or re-index) one Markdown file inside the wiki folder. */
	indexWikiFile(file: string): DocRecord {
		const rel = relative(this.root, file);
		const content = normalizeText(readFileSync(file, "utf8"));
		const hash = sha(content);
		const id = `w-${sha(rel).slice(0, 12)}`;
		const existing = this.store.getDoc(id);
		if (existing?.hash === hash) return existing;
		const note = parseNote(content, basename(file, extname(file)));
		const doc: DocRecord = {
			id,
			title: note.meta.title,
			collection: "wiki",
			kind: "note",
			source: rel,
			path: rel,
			pages: null,
			chars: content.length,
			hash,
			added_at: existing?.added_at ?? new Date().toISOString(),
		};
		// Index the body and tags, not the front matter keys, so "created:" and the like never match.
		const tags = note.meta.tags.map((t) => `#${t}`).join(" ");
		this.store.putDoc(doc, chunkPages([{ page: null, markdown: tags ? `${note.body}\n\n${tags}` : note.body }]));
		return doc;
	}

	/** Bring the index in line with the wiki folder, which people may edit by hand or in Obsidian. */
	syncWiki(): { updated: number; removed: number } {
		const seen = new Set<string>();
		let updated = 0;
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (isMarkdown(entry.name) && !(dir === this.wikiDir && WIKI_META.has(entry.name))) {
					const before = this.store.getDoc(`w-${sha(relative(this.root, full)).slice(0, 12)}`)?.hash;
					const doc = this.indexWikiFile(full);
					seen.add(doc.id);
					if (doc.hash !== before) updated++;
				}
			}
		};
		walk(this.wikiDir);
		let removed = 0;
		for (const doc of this.store.listDocs("wiki")) {
			if (!seen.has(doc.id)) {
				this.store.deleteDoc(doc.id);
				removed++;
			}
		}
		return { updated, removed };
	}

	/**
	 * Build a wiki note without writing it. `create` refuses a title that already
	 * exists so repeated lessons land in one note instead of near-duplicates.
	 */
	prepareNote(input: NoteInput, mode: NoteMode = "create", id?: string): PreparedNote {
		const title = input.title.trim();
		const content = input.content.trim();
		if (!content) throw new Error("Note content is empty");
		const tags = normalizeTags(input.tags);
		if (mode === "create") {
			if (!title) throw new Error("A new note needs a title");
			const same = this.store.listDocs("wiki").find((d) => d.title.toLowerCase() === title.toLowerCase());
			if (same) throw new Error(`A note titled "${same.title}" already exists (${same.id}). Use mode "append" or "replace" with that id.`);
			const slug = slugify(title);
			let file = join(this.wikiDir, `${slug}.md`);
			for (let n = 2; existsSync(file); n++) file = join(this.wikiDir, `${slug}-${n}.md`);
			const date = today();
			return { action: mode, file, note: { meta: { title, tags, created: date, updated: date, project: input.project }, body: content } };
		}
		const existing = id ? this.store.getDoc(id) : undefined;
		if (!existing || existing.collection !== "wiki") throw new Error(`Mode "${mode}" needs the id of an existing wiki note (w-…)`);
		const file = join(this.root, existing.path);
		const current = parseNote(readFileSync(file, "utf8"), existing.title);
		const meta = {
			...current.meta,
			title: (mode === "replace" && title) || current.meta.title,
			tags: normalizeTags([...current.meta.tags, ...tags]),
			created: current.meta.created || existing.added_at.slice(0, 10),
			updated: today(),
			project: current.meta.project ?? input.project,
		};
		const body = mode === "append" ? `${current.body}

## ${today()}

${content}` : content;
		return { action: mode, file, note: { meta, body }, existing };
	}

	/**
	 * Write a prepared note, index it and record the change in wiki/log.md.
	 * `edited` is the full note text after the user changed it in an editor.
	 */
	writeNote(prepared: PreparedNote, edited?: string): DocRecord {
		let note = prepared.note;
		if (edited !== undefined) {
			const parsed = parseNote(edited, note.meta.title);
			const tags = parsed.meta.tags.length ? parsed.meta.tags : note.meta.tags;
			note = { meta: { ...note.meta, title: parsed.meta.title, tags }, body: parsed.body };
		}
		writeFileSync(prepared.file, renderNote(note));
		const doc = this.indexWikiFile(prepared.file);
		const verb = { create: "created", append: "appended", replace: "replaced" }[prepared.action];
		const link = relative(this.wikiDir, prepared.file).replace(/\.md$/, "");
		appendFileSync(join(this.wikiDir, "log.md"), `- ${now()} ${verb} [[${link}]] ${note.meta.title}\n`);
		return doc;
	}

	search(query: string, options: { limit?: number; collection?: Collection } = {}): SearchHit[] {
		return this.store.search(query, options);
	}

	/** Read a document's Markdown, optionally limited to a page range such as "3" or "3-5". */
	read(id: string, pages?: string): { doc: DocRecord; text: string } {
		const doc = this.store.getDoc(id);
		if (!doc) throw new Error(`No knowledge base document with id ${id}`);
		const markdown = readFileSync(join(this.root, doc.path), "utf8");
		if (!pages?.trim()) return { doc, text: markdown };
		const range = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(pages);
		if (!range) throw new Error('pages must look like "3" or "3-5"');
		if (!doc.pages) throw new Error(`${doc.title} has no pages; omit the pages argument`);
		const from = Number(range[1]);
		const to = Math.min(Number(range[2] ?? range[1]), doc.pages);
		const parts = splitConverted(markdown).filter((p) => p.page !== null && p.page >= from && p.page <= to);
		if (!parts.length) throw new Error(`${doc.title} has pages 1-${doc.pages}`);
		return { doc, text: parts.map((p) => `<!-- kb:page ${p.page} -->\n${p.markdown}`).join("\n\n") };
	}

	/** Remove a document; for wiki notes this deletes the note file as well. */
	remove(id: string): DocRecord {
		const doc = this.store.getDoc(id);
		if (!doc) throw new Error(`No knowledge base document with id ${id}`);
		if (doc.collection === "docs") rmSync(join(this.root, "raw", doc.id), { recursive: true, force: true });
		rmSync(join(this.root, doc.path), { force: true });
		this.store.deleteDoc(id);
		return doc;
	}

	/** A compact catalog for the system prompt: counts plus wiki note titles. */
	catalog(maxNotes = 40): string {
		const { docs, wiki, pages } = this.store.stats();
		const lines = [`${docs} document(s)${pages ? `, ${pages} page(s)` : ""}; ${wiki} wiki note(s).`];
		const notes = this.store.listDocs("wiki");
		if (notes.length) {
			lines.push("Wiki notes:");
			for (const note of notes.slice(0, maxNotes)) lines.push(`- ${note.title} (${note.id})`);
			if (notes.length > maxNotes) lines.push(`- …and ${notes.length - maxNotes} more; use kb_search to find them.`);
		}
		const recent = this.store.listDocs("docs").slice(0, 15);
		if (recent.length) {
			lines.push("Recent documents:");
			for (const doc of recent) lines.push(`- ${doc.title}${doc.pages ? `, ${doc.pages} pages` : ""} (${doc.id})`);
		}
		return lines.join("\n");
	}
}

function renderConverted(title: string, pages: ConvertedPage[]): string {
	const body = pages
		.map((p) => (p.page === null ? p.markdown : `<!-- kb:page ${p.page} -->\n${p.markdown}`))
		.join("\n\n");
	return `<!-- kb:source ${title} -->\n\n${body}\n`;
}

function splitConverted(markdown: string): ConvertedPage[] {
	const parts = markdown.split(/(?=^<!-- kb:page \d+ -->$)/m);
	return parts.map((part) => {
		const match = PAGE_MARK.exec(part);
		return { page: match ? Number(match[1]) : null, markdown: part.replace(PAGE_MARK, "").trim() };
	});
}

