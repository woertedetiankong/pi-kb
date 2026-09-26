import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chunkPages } from "./chunk.ts";
import { configStamp, defaultMinScore, type KbConfig, loadConfig, saveConfig } from "./config.ts";
import { type ConvertedPage, Converter, type OcrShare, type PageImage, isMarkdown, normalizeText, sourceKind } from "./convert.ts";
import { type Note, normalizeTags, now, parseNote, renderNote, slugify, today } from "./notes.ts";
import { fuse } from "./search.ts";
import { type IndexerStatus, SemanticIndexer } from "./semantic/indexer.ts";
import { createProvider, type EmbeddingProvider } from "./semantic/providers.ts";
import { VectorIndex } from "./semantic/vectors.ts";
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
export type AddReason =
	| "not_found"
	| "unsupported"
	| "no_text"
	| "ocr_unavailable"
	| "not_markdown"
	| "needs_libreoffice"
	| "cancelled"
	/** Already in the other knowledge base (project or global), so not imported twice. */
	| "in_project"
	| "in_global";

export interface AddResult {
	path: string;
	status: "added" | "exists" | "skipped" | "failed";
	doc?: DocRecord;
	reason?: AddReason;
	/** English detail for the model and for unexpected errors. */
	message?: string;
	/** Ids of the older versions this import replaced. */
	replaced?: string[];
}

/**
 * Vector search always returns the "closest" chunks, even when nothing is related, and small
 * models give unrelated queries similarities as high as related ones. So chunks found only by
 * meaning are capped: a few next to keyword hits, a few more when keywords found nothing
 * (for example a question in another language).
 */
const SEMANTIC_ONLY_WITH_KEYWORDS = 3;
const SEMANTIC_ONLY_ALONE = 5;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** An imported document's id: from its content, so importing the same file again is noticed. */
export const contentId = (bytes: Buffer) => `k-${sha(bytes).slice(0, 12)}`;

/**
 * A wiki note's id: from its path inside the content folder, with forward slashes on every system.
 * A project's notes hash differently, so a project note and a global note at the same path
 * (wiki/xr-100-spi.md in both) never share an id and hide each other.
 */
const wikiId = (root: string, file: string, project: boolean) =>
	`w-${sha(`${project ? "project:" : ""}${relative(root, file).split(sep).join("/")}`).slice(0, 12)}`;

/**
 * The search index for a content folder. The default layout keeps it in the folder (kb.db, as
 * before); a folder elsewhere gets one under this machine's indexes/, keyed by its path.
 */
export function indexFile(localDir: string, dir: string): string {
	if (resolve(dir) === resolve(localDir)) return join(localDir, "kb.db");
	return join(localDir, "indexes", sha(resolve(dir)).slice(0, 12), "kb.db");
}
const PAGE_MARK = /^<!-- kb:page (\d+) -->$/m;
/**
 * How much of a page's text came from OCR, on its own line after the page marker. A separate line
 * rather than part of the page marker, so versions before it still split pages correctly.
 */
const OCR_MARK = /^<!-- kb:ocr (\d+)\/(\d+) -->\n?/m;
const OCR_MARKS = new RegExp(OCR_MARK.source, "gm");
/** Files kept in the wiki folder for navigation and history rather than as knowledge. */
const WIKI_META = new Set(["index.md", "log.md", "SCHEMA.md"]);

export function expandHome(path: string): string {
	return path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Inputs that resolve outside `dir`, following symlinks so a link inside the project cannot
 * point elsewhere unnoticed. Missing paths are judged by where they would be.
 */
export function pathsOutside(inputs: string[], dir: string): string[] {
	// Resolve the nearest existing ancestor, so a missing file under /var still compares with /private/var.
	const real = (path: string): string => {
		try {
			return realpathSync(path);
		} catch {
			const parent = dirname(path);
			return parent === path ? path : join(real(parent), basename(path));
		}
	};
	const base = real(resolve(dir));
	return inputs.filter((input) => {
		const rel = relative(base, real(resolve(dir, expandHome(input))));
		return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	});
}

/** The last `depth` parts of a document's source path, e.g. "project-3/README.md"; uploads have only a name. */
export function sourcePath(source: string, depth: number): string {
	const path = source.startsWith("upload:") ? source.slice("upload:".length) : source;
	return path.split(/[\\/]+/).filter(Boolean).slice(-depth).join("/");
}

/** A page (null for an unpaged document) and how much of its text came from OCR. */
export type PageOcr = OcrShare & { page: number | null };

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
	readonly vectors: VectorIndex;
	readonly indexer: SemanticIndexer;
	/** Where the content lives: raw/, converted/, docs/ and wiki/. May be a synced or shared folder. */
	readonly root: string;
	/** This machine's own files: config.json, the search index, OCR data and the local model. */
	readonly localDir: string;
	config: KbConfig;
	/** Called whenever background embedding makes progress or fails. */
	onSemantic?: (status: IndexerStatus) => void;
	private provider?: EmbeddingProvider;
	/** A project's knowledge base (shared through git), whose note ids are kept apart from the global one's. */
	private readonly project: boolean;
	/** config.json's modification time and size when last read or written. */
	private configStamp: string;

	/**
	 * `localDir` holds this machine's files; the content lives in `options.dir`, or there too.
	 * The index is a cache of the content (see sync()), so the content folder can be synced
	 * between computers or shared, while SQLite never sits in a synced folder.
	 */
	constructor(localDir: string, options: { dir?: string; project?: boolean } = {}) {
		this.localDir = localDir;
		this.root = options.dir ?? localDir;
		this.project = options.project ?? false;
		for (const dir of ["raw", "converted", "wiki"]) mkdirSync(join(this.root, dir), { recursive: true });
		this.configStamp = configStamp(localDir);
		this.config = loadConfig(localDir);
		this.store = new Store(indexFile(localDir, this.root));
		this.converter = new Converter({
			ocrLanguage: this.config.ocrLanguage,
			tessdataDir: process.env.PI_KB_TESSDATA || join(localDir, "tessdata"),
			ocrServerUrl: this.config.ocrServerUrl,
		});
		this.vectors = new VectorIndex(this.store.db);
		this.indexer = new SemanticIndexer(this.vectors, (status) => this.onSemantic?.(status));
		this.applySemantic();
	}

	/** (Re)create the embedding provider from the config; call kick() on the indexer to start embedding. */
	private applySemantic(): void {
		this.provider = createProvider(this.config.semantic, this.localDir);
		this.indexer.use(this.provider);
	}

	get wikiDir(): string {
		return join(this.root, "wiki");
	}

	updateConfig(change: Partial<KbConfig>): void {
		// Start from what is on disk, so a change made in another pi window is not overwritten.
		this.reloadConfig();
		const before = this.config;
		this.config = { ...this.config, ...change };
		saveConfig(this.localDir, this.config);
		this.configStamp = configStamp(this.localDir);
		this.applyChanges(before);
	}

	/** Put settings that changed since `before` into effect. */
	private applyChanges(before: KbConfig): void {
		const { ocrLanguage, ocrServerUrl } = this.config;
		if (ocrLanguage !== before.ocrLanguage || ocrServerUrl !== before.ocrServerUrl) this.converter.setOcr({ ocrLanguage, ocrServerUrl });
		if (JSON.stringify(this.config.semantic) !== JSON.stringify(before.semantic)) {
			this.applySemantic();
			void this.indexer.kick();
		}
	}

	/**
	 * Pick up config.json if something else (another pi window, the web page served by it, an editor) changed it.
	 * Returns true when the config was reloaded.
	 */
	reloadConfig(): boolean {
		const stamp = configStamp(this.localDir);
		if (stamp === this.configStamp) return false;
		this.configStamp = stamp;
		const before = this.config;
		this.config = loadConfig(this.localDir);
		this.applyChanges(before);
		return true;
	}

	close(): void {
		this.indexer.stop();
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
	 * Aborting `signal` stops the conversion and nothing is saved.
	 */
	async addFile(
		path: string,
		options: {
			wiki?: boolean;
			source?: string;
			signal?: AbortSignal;
			replace?: string[];
			/** Told when the import has to wait for something the user should know about. */
			onNote?: (note: "ocr_download") => void;
		} = {},
	): Promise<AddResult> {
		const cancelled = (): AddResult => ({ path, status: "skipped", reason: "cancelled", message: "import cancelled" });
		try {
			if (options.signal?.aborted) return cancelled();
			if (options.wiki) {
				if (!isMarkdown(path)) return { path, status: "skipped", reason: "not_markdown", message: "only Markdown files can become wiki notes" };
				return this.addWikiFile(path);
			}
			if (!sourceKind(path)) {
				return { path, status: "skipped", reason: "unsupported", message: `unsupported type ${extname(path) || "(none)"}` };
			}
			const bytes = readFileSync(path);
			const hash = sha(bytes);
			const id = contentId(bytes);
			const existing = this.store.getDoc(id);
			if (existing) return { path, status: "exists", doc: existing };

			// The first OCR downloads Tesseract data (about 40 MB); say so instead of looking stuck.
			if (Converter.mayOcr(path) && this.converter.missingOcrData().length) options.onNote?.("ocr_download");
			const converted = await this.converter.convert(path, options.signal);
			if (options.signal?.aborted) return cancelled();
			const text = converted.pages.map((p) => p.markdown).join("");
			// Images come back as an empty ```text fence when OCR finds nothing.
			if (!text.replace(/```\w*/g, "").trim()) {
				// Not stored, so importing the same file again (e.g. once online) is a fresh attempt.
				const missing = this.converter.missingOcrData();
				if (missing.length) {
					return { path, status: "failed", reason: "ocr_unavailable", message: `OCR language data could not be downloaded (${missing.join(", ")})` };
				}
				return { path, status: "failed", reason: "no_text", message: "no text could be extracted" };
			}

			const name = basename(path);
			const source = options.source ?? path;
			// A new version takes the title of the first version it replaces, so earlier citations still fit.
			const replaced = (options.replace ?? [])
				.map((old) => this.store.getDoc(old))
				.filter((d): d is DocRecord => d?.collection === "docs")
				.sort((a, b) => a.added_at.localeCompare(b.added_at));
			const title = replaced[0]?.title ?? this.titleFor(source);
			mkdirSync(join(this.root, "raw", id), { recursive: true });
			copyFileSync(path, join(this.root, "raw", id, name));
			const rel = join("converted", `${id}.md`);
			writeFileSync(join(this.root, rel), renderConverted(name, converted.pages));

			const paged = converted.pages.some((p) => p.page !== null);
			const doc: DocRecord = {
				id,
				title,
				collection: "docs",
				kind: converted.kind,
				source,
				path: rel,
				pages: paged ? converted.pages.length : null,
				chars: text.length,
				hash,
				added_at: new Date().toISOString(),
			};
			this.store.putDoc(doc, chunkPages(converted.pages));
			this.writeManifest(doc);
			for (const old of replaced) if (old.id !== id) this.remove(old.id);
			void this.indexer.kick();
			return { path, status: "added", doc, replaced: replaced.map((d) => d.id) };
		} catch (error) {
			if (options.signal?.aborted) return cancelled();
			const message = error instanceof Error ? error.message : String(error);
			return { path, status: "failed", reason: /LibreOffice/.test(message) ? "needs_libreoffice" : undefined, message };
		}
	}

	/**
	 * Imported documents that `path` is a newer version of: the same file imported before (or, for
	 * an upload, a document with the same file name) whose content differs. Empty when the content
	 * is already in the knowledge base, which addFile reports as "already present".
	 */
	previousVersions(path: string, upload?: { name: string }): DocRecord[] {
		if (this.store.getDoc(contentId(readFileSync(path)))) return [];
		const name = upload?.name ?? basename(path);
		return this.store
			.listDocs("docs")
			.filter((d) => (upload ? sourcePath(d.source, 1) === name : d.source === path || d.source === `upload:${name}`));
	}

	/**
	 * A title citations can tell apart: the file name, or when another document has the same name,
	 * as much of the folder path as differs (project-3/README.md). Documents it clashes with get
	 * the same treatment; uploads, which have no folder, are numbered instead.
	 */
	private titleFor(source: string): string {
		const docs = this.store.listDocs("docs");
		const taken = new Set(docs.map((d) => d.title));
		const name = sourcePath(source, 1);
		const upload = source.startsWith("upload:");
		// Once same-named documents show their folders, later ones do too, even while the bare name is free.
		const sameName = docs.filter((d) => (d.title === name || d.title.endsWith(`/${name}`)) && !d.source.startsWith("upload:"));
		if (!taken.has(name) && (!sameName.length || upload)) return name;
		const clashing = sameName.filter((d) => d.title === name);
		const depth = upload ? 1 : source.split(/[\\/]+/).filter(Boolean).length;
		for (let k = 2; k <= depth; k++) {
			const title = sourcePath(source, k);
			// Show enough folders to differ from every same-named document, not only the ones still bare.
			if (taken.has(title) || sameName.some((d) => sourcePath(d.source, k) === title)) continue;
			for (const d of clashing) {
				const renamed = sourcePath(d.source, k);
				if (!taken.has(renamed)) this.retitle(d, renamed);
			}
			return title;
		}
		for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
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
		const id = wikiId(this.root, file, this.project);
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
		void this.indexer.kick();
		return doc;
	}

	/**
	 * Bring the index in line with the content folder: documents (docs/*.json + converted/) and wiki
	 * notes. Needed at start, and whenever another computer or a teammate may have changed the folder.
	 */
	sync(): { updated: number; removed: number } {
		// Taken first, so a change made while syncing is still noticed next time.
		const stamp = this.contentStamp();
		const docs = this.syncDocs();
		const wiki = this.syncWiki();
		this.syncedStamp = stamp;
		this.checkedAt = Date.now();
		if (docs.updated) void this.indexer.kick();
		return { updated: docs.updated + wiki.updated, removed: docs.removed + wiki.removed };
	}

	private syncedStamp?: string;
	private checkedAt = 0;

	/**
	 * Sync when the files changed since the last sync, e.g. after a git pull brought teammates' notes.
	 * Looks at file sizes and times only, and at most once per `every` ms; undefined when nothing was done.
	 */
	syncIfChanged(every = 2000): { updated: number; removed: number } | undefined {
		if (Date.now() - this.checkedAt < every) return undefined;
		this.checkedAt = Date.now();
		if (this.contentStamp() === this.syncedStamp) return undefined;
		return this.sync();
	}

	/** Every file the index is built from, with its size and modification time. */
	private contentStamp(): string {
		const parts: string[] = [];
		const walk = (dir: string) => {
			let entries: Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else {
					try {
						const info = statSync(full);
						parts.push(`${full}\t${info.size}\t${info.mtimeMs}`);
					} catch {
						// removed while looking: the next check sees it
					}
				}
			}
		};
		for (const sub of ["docs", "converted", "wiki"]) walk(join(this.root, sub));
		return parts.join("\n");
	}

	private manifestFile(id: string): string {
		return join(this.root, "docs", `${id}.json`);
	}

	/** Each document's facts in a small file of its own, so the index can be rebuilt and folders merged without conflicts. */
	private writeManifest(doc: DocRecord): void {
		mkdirSync(join(this.root, "docs"), { recursive: true });
		// Forward slashes, so a folder shared between Windows and macOS reads the same.
		const record = { ...doc, path: doc.path.split(sep).join("/") };
		writeFileSync(this.manifestFile(doc.id), `${JSON.stringify(record, null, 2)}\n`);
	}

	private retitle(doc: DocRecord, title: string): void {
		this.store.renameDoc(doc.id, title);
		this.writeManifest({ ...doc, title });
	}

	/** Index documents described in docs/ and drop the ones whose description is gone. */
	private syncDocs(): { updated: number; removed: number } {
		const dir = join(this.root, "docs");
		// Knowledge bases from before docs/ existed: describe what the index knows, once.
		if (!existsSync(dir)) {
			for (const doc of this.store.listDocs("docs")) this.writeManifest(doc);
			return { updated: 0, removed: 0 };
		}
		const seen = new Set<string>();
		let updated = 0;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			let record: DocRecord;
			try {
				record = JSON.parse(readFileSync(join(dir, name), "utf8"));
			} catch {
				continue; // half-synced or hand-broken file: try again next time
			}
			if (typeof record?.id !== "string" || `${record.id}.json` !== name || typeof record.path !== "string") continue;
			const file = join(this.root, record.path);
			if (!existsSync(file)) continue; // the text has not arrived yet (sync in progress)
			seen.add(record.id);
			const doc: DocRecord = { ...record, collection: "docs", path: record.path.split("/").join(sep) };
			const known = this.store.getDoc(record.id);
			if (!known) {
				this.store.putDoc(doc, chunkPages(pagesOf(readFileSync(file, "utf8"))));
				updated++;
			} else if (known.title !== doc.title) {
				this.store.renameDoc(doc.id, doc.title);
			}
		}
		let removed = 0;
		for (const doc of this.store.listDocs("docs")) {
			if (!seen.has(doc.id)) {
				this.store.deleteDoc(doc.id);
				removed++;
			}
		}
		return { updated, removed };
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
					const before = this.store.getDoc(wikiId(this.root, full, this.project))?.hash;
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
			// Local date, like `updated`: the UTC one is a day ahead in the evening in the US.
			created: current.meta.created || today(new Date(existing.added_at)),
			updated: today(),
			project: current.meta.project ?? input.project,
		};
		const body = mode === "append" ? `${current.body}\n\n${appendSection(content, today())}` : content;
		return { action: mode, file, note: { meta, body }, existing };
	}

	/**
	 * Write a prepared note, index it and record the change in wiki/log.md.
	 * `edited` is the full note text after the user changed it in an editor (or a note being
	 * moved here); its front matter wins, and fields it leaves out keep the prepared values.
	 */
	writeNote(prepared: PreparedNote, edited?: string): DocRecord {
		let note = prepared.note;
		if (edited !== undefined) {
			const { meta, body } = parseNote(edited, note.meta.title);
			note = {
				meta: {
					title: meta.title,
					tags: meta.tags.length ? meta.tags : note.meta.tags,
					created: meta.created || note.meta.created,
					updated: meta.updated || note.meta.updated,
					project: meta.project ?? note.meta.project,
				},
				body,
			};
		}
		writeFileSync(prepared.file, renderNote(note));
		const doc = this.indexWikiFile(prepared.file);
		this.log({ create: "created", append: "appended", replace: "replaced" }[prepared.action], prepared.file, note.meta.title);
		return doc;
	}

	/** Save a wiki note's full text as edited by hand (for example on the web page). */
	editNote(id: string, text: string): DocRecord {
		const doc = this.store.getDoc(id);
		if (!doc || doc.collection !== "wiki") throw new Error(`No wiki note with id ${id}`);
		const file = join(this.root, doc.path);
		writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
		const updated = this.indexWikiFile(file);
		this.log("edited", file, updated.title);
		return updated;
	}

	/** The imported original of a document, for viewing or download. */
	originalFile(id: string): { file: string; name: string } {
		const doc = this.store.getDoc(id);
		if (!doc || doc.collection !== "docs") throw new Error(`No imported document with id ${id}`);
		const dir = join(this.root, "raw", doc.id);
		const name = readdirSync(dir)[0];
		if (!name) throw new Error(`The original of ${doc.title} is missing`);
		return { file: join(dir, name), name };
	}

	private tags = new Map<string, { hash: string; tags: string[] }>();

	/** A note's tags from its front matter, read again only when the note changed. */
	noteTags(doc: DocRecord): string[] {
		const cached = this.tags.get(doc.id);
		if (cached?.hash === doc.hash) return cached.tags;
		let tags: string[] = [];
		try {
			tags = normalizeTags(parseNote(readFileSync(join(this.root, doc.path), "utf8"), doc.title).meta.tags);
		} catch {
			// removed meanwhile: no tags
		}
		this.tags.set(doc.id, { hash: doc.hash, tags });
		return tags;
	}

	/** The note file as stored, front matter included. */
	noteText(id: string): string {
		const doc = this.store.getDoc(id);
		if (!doc || doc.collection !== "wiki") throw new Error(`No wiki note with id ${id}`);
		return readFileSync(join(this.root, doc.path), "utf8");
	}

	private log(verb: string, file: string, title: string): void {
		const link = relative(this.wikiDir, file).replace(/\.md$/, "");
		appendFileSync(join(this.wikiDir, "log.md"), `- ${now()} ${verb} [[${link}]] ${title}\n`);
	}

	/** Keyword search only (synchronous). */
	search(query: string, options: { limit?: number; collection?: Collection } = {}): SearchHit[] {
		return this.store.search(query, options);
	}

	/**
	 * Hybrid search: keyword and semantic results fused by rank. Falls back to keywords
	 * when semantic search is off, not indexed yet, or the query cannot be embedded.
	 */
	async find(query: string, options: { limit?: number; collection?: Collection } = {}): Promise<SearchHit[]> {
		const limit = options.limit ?? 8;
		const keyword = this.store.search(query, { limit: 40, collection: options.collection });
		const semantic = await this.semanticChunks(query, options.collection);
		if (!semantic) return keyword.slice(0, limit).map((h) => ({ ...h, match: "keyword" as const }));
		let semanticOnly = keyword.length ? SEMANTIC_ONLY_WITH_KEYWORDS : SEMANTIC_ONLY_ALONE;
		const fused = fuse(
			keyword.map((h) => h.chunk),
			semantic.map((h) => h.rowid),
		)
			.filter((f) => f.match !== "semantic" || semanticOnly-- > 0)
			.slice(0, limit);
		const byChunk = new Map(keyword.map((h) => [h.chunk, h]));
		const extra = this.store.chunks(fused.filter((f) => !byChunk.has(f.chunk)).map((f) => f.chunk));
		return fused.flatMap((f) => {
			const hit = byChunk.get(f.chunk) ?? extra.get(f.chunk);
			return hit ? [{ ...hit, score: f.score, match: f.match }] : [];
		});
	}

	/** Semantic search alone (for evaluation): the chunks above the similarity floor, best first. */
	async findSemantic(query: string, options: { limit?: number; collection?: Collection } = {}): Promise<SearchHit[]> {
		const semantic = (await this.semanticChunks(query, options.collection)) ?? [];
		const top = semantic.slice(0, options.limit ?? 8);
		const hits = this.store.chunks(top.map((h) => h.rowid));
		return top.flatMap((h) => {
			const hit = hits.get(h.rowid);
			return hit ? [{ ...hit, score: h.score, match: "semantic" as const }] : [];
		});
	}

	/**
	 * Whether semantic results have a similarity floor (measured for the model, or set in the config).
	 * Without one the closest notes always come back, related or not.
	 */
	semanticFloor(): boolean {
		const cfg = this.config.semantic;
		return (cfg.minScore ?? defaultMinScore(cfg.provider === "api" ? cfg.api.model : cfg.local.model)) !== undefined;
	}

	/** Whether semantic search can answer now (provider set and some chunks embedded). */
	semanticReady(): boolean {
		return !!this.provider && this.vectors.progress(this.provider.key).done > 0;
	}

	/**
	 * Chunks close in meaning, filtered by the model's similarity floor. Undefined when semantic
	 * search is off, not indexed yet, or the query cannot be embedded (offline, no key).
	 */
	private async semanticChunks(query: string, collection?: Collection) {
		const provider = this.provider;
		if (!provider || !query.trim() || !this.semanticReady()) return undefined;
		let vector: Float32Array;
		try {
			[vector] = await provider.embed([query], "query");
		} catch {
			return undefined;
		}
		const cfg = this.config.semantic;
		const minScore = cfg.minScore ?? defaultMinScore(cfg.provider === "api" ? cfg.api.model : cfg.local.model);
		return this.vectors.search(provider.key, vector, 40, collection).filter((h) => minScore === undefined || h.score >= minScore);
	}

	/** Start embedding whatever is new (no-op when semantic search is off). */
	indexSemantic(): Promise<void> {
		return this.indexer.kick();
	}

	/** Read a document's Markdown, optionally limited to a page range such as "3" or "3-5". */
	/**
	 * Read a document's Markdown, optionally limited to a page range such as "3" or "3-5". `ocr` lists
	 * the pages read whose text came partly or wholly from OCR.
	 */
	read(id: string, pages?: string): { doc: DocRecord; text: string; ocr: PageOcr[] } {
		const doc = this.store.getDoc(id);
		if (!doc) throw new Error(`No knowledge base document with id ${id}`);
		const markdown = readFileSync(join(this.root, doc.path), "utf8");
		const ocrOf = (parts: ConvertedPage[]) => parts.flatMap((p) => (p.ocr ? [{ page: p.page, ...p.ocr }] : []));
		if (!pages?.trim()) return { doc, text: markdown.replace(OCR_MARKS, ""), ocr: ocrOf(pagesOf(markdown)) };
		const { from, to } = pageRange(doc, pages);
		const parts = splitConverted(markdown).filter((p) => p.page !== null && p.page >= from && p.page <= to);
		if (!parts.length) throw new Error(`${doc.title} has pages 1-${doc.pages}`);
		return { doc, text: parts.map((p) => `<!-- kb:page ${p.page} -->\n${p.markdown}`).join("\n\n"), ocr: ocrOf(parts) };
	}

	/**
	 * Render pages of an imported document from its original, so a model can see figures, diagrams
	 * and layout that the converted text loses. An image document is its one page; a paged document
	 * needs `pages`, at most `limit` of them.
	 */
	async renderPages(id: string, pages: string | undefined, limit: number, signal?: AbortSignal): Promise<{ doc: DocRecord; images: PageImage[] }> {
		const doc = this.store.getDoc(id);
		if (!doc) throw new Error(`No knowledge base document with id ${id}`);
		if (doc.collection !== "docs" || doc.kind === "text") throw new Error(`${doc.title} is text only; there is no page to view`);
		let numbers = [1];
		if (doc.pages) {
			if (!pages?.trim()) throw new Error(`Say which pages of ${doc.title} to view, e.g. pages: "3" or "3-4"`);
			const { from, to } = pageRange(doc, pages);
			if (from > to) throw new Error(`${doc.title} has pages 1-${doc.pages}`);
			if (to - from + 1 > limit) throw new Error(`View at most ${limit} pages at a time`);
			numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
		}
		const { file } = this.originalFile(id);
		return { doc, images: await this.converter.render(file, numbers, signal) };
	}

	/** Remove a document; for wiki notes this deletes the note file as well. */
	remove(id: string): DocRecord {
		const doc = this.store.getDoc(id);
		if (!doc) throw new Error(`No knowledge base document with id ${id}`);
		if (doc.collection === "docs") {
			rmSync(join(this.root, "raw", doc.id), { recursive: true, force: true });
			rmSync(this.manifestFile(doc.id), { force: true });
		}
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

/**
 * An appended section dated so readers can tell what came later. Content that opens with its own
 * heading keeps it (as ##) with the date on the line below; otherwise the date is the heading.
 */
export function appendSection(content: string, date: string): string {
	const heading = /^#{1,6}[ \t]+(.+)(?:\n|$)/.exec(content);
	if (!heading) return `## ${date}\n\n${content}`;
	const rest = content.slice(heading[0].length).trim();
	return `## ${heading[1].trim()}\n\n_${date}_${rest ? `\n\n${rest}` : ""}`;
}

function renderConverted(title: string, pages: ConvertedPage[]): string {
	const body = pages
		.map((p) => {
			const ocr = p.ocr ? `<!-- kb:ocr ${p.ocr.chars}/${p.ocr.total} -->\n` : "";
			return p.page === null ? `${ocr}${p.markdown}` : `<!-- kb:page ${p.page} -->\n${ocr}${p.markdown}`;
		})
		.join("\n\n");
	return `<!-- kb:source ${title} -->\n\n${body}\n`;
}

/** The pages a document was indexed from, read back from its converted Markdown. */
function pagesOf(markdown: string): ConvertedPage[] {
	const pages = splitConverted(markdown.replace(/^<!-- kb:source .* -->\n*/, ""));
	// A paged document starts with an empty part before its first page marker.
	return pages.some((p) => p.page !== null) ? pages.filter((p) => p.page !== null) : pages;
}

function splitConverted(markdown: string): ConvertedPage[] {
	const parts = markdown.split(/(?=^<!-- kb:page \d+ -->$)/m);
	return parts.map((part) => {
		const match = PAGE_MARK.exec(part);
		const ocr = OCR_MARK.exec(part);
		const page: ConvertedPage = { page: match ? Number(match[1]) : null, markdown: part.replace(PAGE_MARK, "").replace(OCR_MARK, "").trim() };
		if (ocr) page.ocr = { chars: Number(ocr[1]), total: Number(ocr[2]) };
		return page;
	});
}


/** Parse a page argument such as "3" or "3-5"; the end is clamped to the document's last page. */
function pageRange(doc: DocRecord, pages: string): { from: number; to: number } {
	const range = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(pages);
	if (!range) throw new Error('pages must look like "3" or "3-5"');
	if (!doc.pages) throw new Error(`${doc.title} has no pages; omit the pages argument`);
	return { from: Number(range[1]), to: Math.min(Number(range[2] ?? range[1]), doc.pages) };
}
