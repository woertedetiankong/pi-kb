import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type KnowledgeBase, pathsOutside } from "./kb.ts";
import { parseNote } from "./notes.ts";
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

/**
 * Where an import goes when nobody chose: files inside the project to its knowledge base, files
 * from anywhere else to the global one, so a personal or vendor file is not committed for the team.
 */
export function importScope(path: string, projectRoot: string | undefined): Scope {
	return projectRoot && !pathsOutside([path], projectRoot).length ? "project" : "global";
}

/** Reciprocal-rank constant, as in hybrid search: merges two ranked lists without comparing their scores. */
const RRF_K = 60;

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
			// Written as it is, so its dates and tags survive the move.
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
