import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AddResult, contentId, type KnowledgeBase, pathsOutside } from "./kb.ts";
import { parseNote, titleSimilarity, wikiLinks } from "./notes.ts";
import type { ProjectKb } from "./project.ts";
import type { Collection, DocRecord, SearchHit } from "./store.ts";

/**
 * The knowledge bases in reach: the user's global one and, inside a project that has one, the
 * project's (shared with the team through git). Searches cover both; everything else goes to the
 * one that holds the document, found by id, the project first.
 */

export type Scope = "project" | "global";
export type ScopedHit = SearchHit & { scope: Scope };
export type ScopedDoc = DocRecord & { scope: Scope };
type SearchOptions = { limit?: number; collection?: Collection };

/** A note that may already cover a new one: its title is alike, or a search for the new title finds it. */
export type SimilarNote = ScopedDoc & { why: "title" | "search"; match?: SearchHit["match"] };

/** What /kb lint reports about the wiki notes. */
export interface WikiReport {
	notes: number;
	/** Pairs of notes that probably say the same thing. */
	duplicates: [ScopedDoc, ScopedDoc][];
	/** [[links]] to notes that do not exist. */
	broken: { note: ScopedDoc; target: string }[];
	/** Project notes linking to a note in the global knowledge base, which teammates do not have. */
	private: { note: ScopedDoc; target: ScopedDoc }[];
	untagged: ScopedDoc[];
}

/**
 * Where an import goes when nobody chose: files inside the project to its knowledge base, files
 * from anywhere else to the global one, so a personal or vendor file is not committed for the team.
 */
export function importScope(path: string, projectRoot: string | undefined): Scope {
	return projectRoot && !pathsOutside([path], projectRoot).length ? "project" : "global";
}

/** Reciprocal-rank constant, as in hybrid search: merges two ranked lists without comparing their scores. */
const RRF_K = 60;
/**
 * Titles at least this alike count as the same topic: "XR100 SPI clock divider" and "XR-100 SPI
 * divider" score 0.81, "SPI 时钟分频踩坑" and "SPI 时钟分频的坑" 0.75, while titles sharing only a
 * word ("Board wiring", "UART wiring") stay near 0.6.
 */
const SIMILAR_TITLE = 0.7;

export class Library {
	readonly global: KnowledgeBase;
	readonly project?: { kb: KnowledgeBase; info: ProjectKb };

	constructor(global: KnowledgeBase, project?: { kb: KnowledgeBase; info: ProjectKb }) {
		this.global = global;
		this.project = project;
	}

	/** Project first: on equal footing its documents win. */
	get scopes(): [Scope, KnowledgeBase][] {
		return this.project ? [["project", this.project.kb], ["global", this.global]] : [["global", this.global]];
	}

	kb(scope: Scope): KnowledgeBase {
		if (scope === "global") return this.global;
		if (!this.project) throw new Error("This folder has no project knowledge base; run /kb init to create one");
		return this.project.kb;
	}

	/** Where new documents and notes go unless the user says otherwise: the project, when there is one. */
	get defaultScope(): Scope {
		return this.project ? "project" : "global";
	}

	/** The knowledge base holding this document or note. */
	locate(id: string): { kb: KnowledgeBase; scope: Scope; doc: DocRecord } | undefined {
		for (const [scope, kb] of this.scopes) {
			const doc = kb.store.getDoc(id);
			if (doc) return { kb, scope, doc };
		}
		return undefined;
	}

	/**
	 * Import a file into `scope`. A document already in the other knowledge base is not imported
	 * again: both copies would have the same id, and the project's would hide the global one.
	 */
	async addFile(scope: Scope, path: string, options: Parameters<KnowledgeBase["addFile"]>[1] = {}): Promise<AddResult> {
		const other = this.scopes.find(([s]) => s !== scope);
		if (other && !options.wiki) {
			let doc: DocRecord | undefined;
			try {
				doc = other[1].store.getDoc(contentId(readFileSync(path)));
			} catch {
				// unreadable: addFile reports it
			}
			if (doc) return { path, status: "exists", doc, reason: other[0] === "project" ? "in_project" : "in_global" };
		}
		return this.kb(scope).addFile(path, options);
	}

	private need(id: string) {
		const found = this.locate(id);
		if (!found) throw new Error(`No knowledge base document with id ${id}`);
		return found;
	}

	/** Both knowledge bases searched, merged by rank (their scores are not comparable), project first on ties. */
	find(query: string, options: SearchOptions = {}): Promise<ScopedHit[]> {
		return this.merge(options, (kb, limit) => kb.find(query, { ...options, limit }));
	}

	/** Keyword search only, merged the same way (for evaluation). */
	search(query: string, options: SearchOptions = {}): Promise<ScopedHit[]> {
		return this.merge(options, (kb, limit) => kb.search(query, { ...options, limit }));
	}

	/** Semantic search only, merged the same way (for evaluation). */
	findSemantic(query: string, options: SearchOptions = {}): Promise<ScopedHit[]> {
		return this.merge(options, (kb, limit) => kb.findSemantic(query, { ...options, limit }));
	}

	/** Whether semantic search can answer in either knowledge base. */
	semanticReady(): boolean {
		return this.scopes.some(([, kb]) => kb.semanticReady());
	}

	private async merge(options: SearchOptions, each: (kb: KnowledgeBase, limit: number) => SearchHit[] | Promise<SearchHit[]>): Promise<ScopedHit[]> {
		const limit = options.limit ?? 8;
		if (!this.project) return (await each(this.global, limit)).map((h) => ({ ...h, scope: "global" }));
		const merged: { hit: ScopedHit; score: number }[] = [];
		for (const [scope, kb] of this.scopes) {
			const hits = await each(kb, limit);
			hits.forEach((hit, rank) => merged.push({ hit: { ...hit, scope }, score: 1 / (RRF_K + rank) + (scope === "project" ? 1e-9 : 0) }));
		}
		return merged
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((m) => m.hit);
	}

	/**
	 * Notes that may already cover what a new note titled `title` is about, best first: alike titles,
	 * then notes a search for the title finds (semantic too when it is on and the model has a similarity
	 * floor, so a Chinese note turns up for an English title).
	 */
	async similarNotes(title: string, options: { limit?: number; exclude?: string } = {}): Promise<SimilarNote[]> {
		const limit = options.limit ?? 3;
		const notes = this.listDocs("wiki").filter((d) => d.id !== options.exclude);
		const found = new Map<string, SimilarNote>();
		notes
			.map((d) => ({ d, score: titleSimilarity(title, d.title) }))
			.filter((x) => x.score >= SIMILAR_TITLE)
			.sort((a, b) => b.score - a.score)
			.forEach(({ d }) => found.set(d.id, { ...d, why: "title" }));
		if (title.trim()) {
			const byId = new Map(notes.map((d) => [d.id, d]));
			for (const hit of await this.find(title, { collection: "wiki", limit: limit + 1 })) {
				// Found by meaning alone: only trusted where a similarity floor keeps unrelated notes out.
				if (hit.match === "semantic" && !this.kb(hit.scope).semanticFloor()) continue;
				const d = byId.get(hit.docId);
				if (d && !found.has(d.id)) found.set(d.id, { ...d, why: "search", match: hit.match });
			}
		}
		return [...found.values()].slice(0, limit);
	}

	/**
	 * The note a [[link]] points to: a path inside wiki/ or a file name (without .md), else a title,
	 * ignoring case and any #heading. Notes in `prefer` (the linking note's knowledge base) win.
	 */
	resolveLink(target: string, prefer: Scope = "project"): ScopedDoc | undefined {
		const name = target.split("#")[0].trim().replace(/\.md$/i, "").toLowerCase();
		if (!name) return undefined;
		const scopes = this.scopes.sort(([a], [b]) => (a === prefer ? -1 : b === prefer ? 1 : 0));
		const inWiki = (d: DocRecord) => d.path.split(/[\\/]/).slice(1).join("/").replace(/\.md$/i, "").toLowerCase();
		const tests = [(d: DocRecord) => inWiki(d) === name || inWiki(d).split("/").pop() === name, (d: DocRecord) => d.title.toLowerCase() === name];
		for (const test of tests) {
			for (const [scope, kb] of scopes) {
				const doc = kb.store.listDocs("wiki").find(test);
				if (doc) return { ...doc, scope };
			}
		}
		return undefined;
	}

	/** A note's tags, for browsing by tag. */
	noteTags(doc: ScopedDoc): string[] {
		return this.kb(doc.scope).noteTags(doc);
	}

	/**
	 * Look over the wiki for what needs a person: likely duplicates (alike titles, or two notes that
	 * semantic search finds first for each other's title), broken [[links]], project notes linking
	 * to global ones, and notes without tags.
	 */
	async checkWiki(): Promise<WikiReport> {
		const notes = this.listDocs("wiki");
		const report: WikiReport = { notes: notes.length, duplicates: [], broken: [], private: [], untagged: [] };
		const pairs = new Map<string, [ScopedDoc, ScopedDoc]>();
		const pair = (a: ScopedDoc, b: ScopedDoc) => {
			const key = [a.id, b.id].sort().join(" ");
			if (!pairs.has(key)) pairs.set(key, a.id < b.id ? [a, b] : [b, a]);
		};
		/** Note id → the note a search for its title finds first, when semantic search had a say. */
		const first = new Map<string, ScopedDoc>();
		for (const note of notes) {
			const similar = await this.similarNotes(note.title, { exclude: note.id });
			for (const s of similar) if (s.why === "title") pair(note, s);
			const top = similar.find((s) => s.why === "search");
			// Keyword matches alone are too loose here: related notes share words without repeating each other.
			if (top && top.match !== "keyword") first.set(note.id, top);
			const { meta, body } = parseNote(this.noteText(note.id), note.title);
			if (!meta.tags.length) report.untagged.push(note);
			for (const target of wikiLinks(body)) {
				const to = this.resolveLink(target, note.scope);
				if (!to) report.broken.push({ note, target });
				else if (note.scope === "project" && to.scope === "global") report.private.push({ note, target: to });
			}
		}
		for (const [id, other] of first) if (first.get(other.id)?.id === id) pair(first.get(other.id)!, other);
		report.duplicates = [...pairs.values()];
		return report;
	}

	/** Full text of hits' chunks (chunk numbers are per knowledge base). */
	chunkTexts(hits: ScopedHit[]): Map<ScopedHit, string> {
		const out = new Map<ScopedHit, string>();
		for (const [scope, kb] of this.scopes) {
			const mine = hits.filter((h) => h.scope === scope);
			const texts = kb.store.chunkTexts(mine.map((h) => h.chunk));
			for (const h of mine) {
				const text = texts.get(h.chunk);
				if (text !== undefined) out.set(h, text);
			}
		}
		return out;
	}

	listDocs(collection?: Collection): ScopedDoc[] {
		return this.scopes.flatMap(([scope, kb]) => kb.store.listDocs(collection).map((d) => ({ ...d, scope })));
	}

	stats(): { docs: number; wiki: number; pages: number; project?: { docs: number; wiki: number; pages: number } } {
		const total = { docs: 0, wiki: 0, pages: 0 };
		for (const [, kb] of this.scopes) {
			const s = kb.store.stats();
			total.docs += s.docs;
			total.wiki += s.wiki;
			total.pages += s.pages;
		}
		return this.project ? { ...total, project: this.project.kb.store.stats() } : total;
	}

	read(id: string, pages?: string) {
		const { kb, scope } = this.need(id);
		return { ...kb.read(id, pages), scope };
	}

	noteText(id: string): string {
		return this.need(id).kb.noteText(id);
	}

	editNote(id: string, text: string): DocRecord {
		return this.need(id).kb.editNote(id, text);
	}

	originalFile(id: string) {
		return this.need(id).kb.originalFile(id);
	}

	remove(id: string): ScopedDoc {
		const { kb, scope } = this.need(id);
		return { ...kb.remove(id), scope };
	}

	/** Move a document or note to the other knowledge base (e.g. a lesson that turned out to concern only this project). */
	move(id: string, to: Scope): ScopedDoc {
		const { kb: from, scope, doc } = this.need(id);
		if (scope === to) return { ...doc, scope };
		const target = this.kb(to);
		let moved: DocRecord;
		if (doc.collection === "wiki") {
			const clash = target.store.listDocs("wiki").find((d) => d.title.toLowerCase() === doc.title.toLowerCase());
			if (clash) throw new Error(`The ${to} knowledge base already has a note titled "${clash.title}" (${clash.id}): merge the two or rename one first`);
			// Written as it is, so its dates, tags and project survive the move.
			const text = from.noteText(id);
			const { meta, body } = parseNote(text, doc.title);
			moved = target.writeNote(target.prepareNote({ title: doc.title, content: body || text, tags: meta.tags }, "create"), text);
		} else {
			// Copy its files (the original may be missing in a project folder: it is not in git by default).
			for (const part of [join("raw", id), doc.path, join("docs", `${id}.json`)]) {
				if (existsSync(join(from.root, part))) cpSync(join(from.root, part), join(target.root, part), { recursive: true });
			}
			target.sync();
			const arrived = target.store.getDoc(id);
			if (!arrived) throw new Error(`could not move ${doc.title}`);
			moved = arrived;
		}
		from.remove(id);
		return { ...moved, scope: to };
	}

	/** Re-read both folders (teammates' pushes arrive in the project one). */
	sync(): { updated: number; removed: number } {
		let updated = 0;
		let removed = 0;
		for (const [, kb] of this.scopes) {
			const r = kb.sync();
			updated += r.updated;
			removed += r.removed;
		}
		return { updated, removed };
	}

	/** What the model sees in its prompt: each knowledge base's notes and recent documents. */
	catalog(): string {
		if (!this.project) return this.global.catalog();
		return [`Project knowledge base "${this.project.info.name}" (shared with the team through git):`, this.project.kb.catalog(), "", "Global (personal) knowledge base:", this.global.catalog()].join("\n");
	}
}
