import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import type { Chunk } from "./chunk.ts";
import { type Candidate, MIN_COVERAGE, planQuery, score, snippet, termScores } from "./search.ts";
import { VECTOR_SCHEMA } from "./semantic/vectors.ts";

const require = createRequire(import.meta.url);

/** Load node:sqlite without printing its ExperimentalWarning into the pi terminal. */
function loadSqlite(): typeof import("node:sqlite") {
	const emit = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (/SQLite/i.test(text)) return;
		return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	try {
		return require("node:sqlite");
	} finally {
		process.emitWarning = emit;
	}
}

export type Collection = "docs" | "wiki";

export interface DocRecord {
	id: string;
	title: string;
	collection: Collection;
	kind: string;
	/** Original file the user imported (docs) or the wiki file path relative to the KB root. */
	source: string;
	/** Converted Markdown path relative to the KB root. */
	path: string;
	pages: number | null;
	chars: number;
	hash: string;
	added_at: string;
}

/**
 * Which documents a search may see by shelf (the global knowledge base's named groups). A shelf
 * narrows what a project sees: documents on no shelf are seen everywhere.
 */
export interface ShelfFilter {
	/** Documents on no shelf, plus those on any of these (a project's choice). */
	any?: string[];
	/** Only the documents on this shelf ("look in the STM32 documents"). */
	only?: string;
}

export interface SearchHit {
	/** Chunk rowid, used to merge keyword and semantic results. */
	chunk: number;
	docId: string;
	title: string;
	collection: Collection;
	page: number | null;
	heading: string;
	snippet: string;
	score: number;
	/** How the chunk matched; set by hybrid search. */
	match?: "keyword" | "semantic" | "both";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  collection TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  pages INTEGER,
  chars INTEGER NOT NULL,
  hash TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shelves (
  doc_id TEXT NOT NULL,
  shelf TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (doc_id, shelf)
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  doc_id UNINDEXED, page UNINDEXED, title, heading, content,
  tokenize = 'trigram'
);
`;

export class Store {
	readonly db: Database;

	constructor(file: string) {
		const { DatabaseSync } = loadSqlite();
		mkdirSync(dirname(file), { recursive: true });
		this.db = new DatabaseSync(file);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(SCHEMA);
		this.db.exec(VECTOR_SCHEMA);
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	getDoc(id: string): DocRecord | undefined {
		return this.db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRecord | undefined;
	}

	listDocs(collection?: Collection): DocRecord[] {
		const sql = collection
			? "SELECT * FROM docs WHERE collection = ? ORDER BY added_at DESC"
			: "SELECT * FROM docs ORDER BY collection, added_at DESC";
		const stmt = this.db.prepare(sql);
		return (collection ? stmt.all(collection) : stmt.all()) as unknown as DocRecord[];
	}

	stats(): { docs: number; wiki: number; pages: number } {
		const row = this.db
			.prepare(
				"SELECT SUM(collection = 'docs') AS docs, SUM(collection = 'wiki') AS wiki, SUM(COALESCE(pages, 0)) AS pages FROM docs",
			)
			.get() as { docs: number | null; wiki: number | null; pages: number | null };
		return { docs: row.docs ?? 0, wiki: row.wiki ?? 0, pages: row.pages ?? 0 };
	}

	/** The shelves a document or note is on, sorted. */
	shelvesOf(id: string): string[] {
		return (this.db.prepare("SELECT shelf FROM shelves WHERE doc_id = ? ORDER BY shelf").all(id) as { shelf: string }[]).map((r) => r.shelf);
	}

	/** Put a document or note on exactly these shelves (none: on no shelf). */
	setShelves(id: string, shelves: string[]): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM shelves WHERE doc_id = ?").run(id);
			const insert = this.db.prepare("INSERT OR IGNORE INTO shelves (doc_id, shelf) VALUES (?, ?)");
			for (const shelf of shelves) insert.run(id, shelf);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Every document's and note's shelves, for listings. */
	shelfMap(): Map<string, string[]> {
		const out = new Map<string, string[]>();
		for (const r of this.db.prepare("SELECT doc_id, shelf FROM shelves ORDER BY shelf").all() as { doc_id: string; shelf: string }[]) {
			out.set(r.doc_id, [...(out.get(r.doc_id) ?? []), r.shelf]);
		}
		return out;
	}

	/** The shelves in use, with how many documents and notes each holds. */
	shelfCounts(): { name: string; docs: number; notes: number }[] {
		return this.db
			.prepare(
				`SELECT s.shelf AS name, SUM(d.collection = 'docs') AS docs, SUM(d.collection = 'wiki') AS notes
         FROM shelves s JOIN docs d ON d.id = s.doc_id GROUP BY s.shelf ORDER BY s.shelf`,
			)
			.all() as { name: string; docs: number; notes: number }[];
	}

	/** SQL condition on documents aliased `d` (with its parameters) for a shelf filter; empty for none. */
	private shelfSql(filter?: ShelfFilter): { sql: string; params: string[] } {
		if (filter?.only !== undefined) return { sql: "AND EXISTS (SELECT 1 FROM shelves s WHERE s.doc_id = d.id AND s.shelf = ?)", params: [filter.only] };
		if (!filter?.any) return { sql: "", params: [] };
		const onNone = "NOT EXISTS (SELECT 1 FROM shelves s WHERE s.doc_id = d.id)";
		if (!filter.any.length) return { sql: `AND ${onNone}`, params: [] };
		const marks = filter.any.map(() => "?").join(", ");
		return { sql: `AND (${onNone} OR EXISTS (SELECT 1 FROM shelves s WHERE s.doc_id = d.id AND s.shelf IN (${marks})))`, params: filter.any };
	}

	/** Ids of the documents and notes a shelf filter lets through (for semantic search). */
	visibleIds(filter: ShelfFilter): Set<string> {
		const { sql, params } = this.shelfSql(filter);
		return new Set((this.db.prepare(`SELECT id FROM docs d WHERE 1 ${sql}`).all(...params) as { id: string }[]).map((r) => r.id));
	}

	/** Change a document's title; its chunks carry the title too, and their vectors are rebuilt. */
	renameDoc(id: string, title: string): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("UPDATE docs SET title = ? WHERE id = ?").run(title, id);
			this.db.prepare("UPDATE chunks SET title = ? WHERE doc_id = ?").run(title, id);
			this.db.prepare("DELETE FROM vectors WHERE doc_id = ?").run(id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Replace a document and all of its chunks atomically. */
	putDoc(doc: DocRecord, chunks: Chunk[]): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(doc.id);
			// New chunks get new rowids; their vectors are rebuilt in the background.
			this.db.prepare("DELETE FROM vectors WHERE doc_id = ?").run(doc.id);
			this.db
				.prepare(
					`INSERT OR REPLACE INTO docs (id, title, collection, kind, source, path, pages, chars, hash, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(doc.id, doc.title, doc.collection, doc.kind, doc.source, doc.path, doc.pages, doc.chars, doc.hash, doc.added_at);
			const insert = this.db.prepare("INSERT INTO chunks (doc_id, page, title, heading, content) VALUES (?, ?, ?, ?, ?)");
			for (const c of chunks) insert.run(doc.id, c.page, doc.title, c.heading, c.content);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	deleteDoc(id: string): void {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(id);
			this.db.prepare("DELETE FROM vectors WHERE doc_id = ?").run(id);
			this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
			this.db.prepare("DELETE FROM shelves WHERE doc_id = ?").run(id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Chunks by rowid (for semantic hits), with a snippet from the start of each chunk. */
	chunks(rowids: number[]): Map<number, Omit<SearchHit, "score">> {
		const out = new Map<number, Omit<SearchHit, "score">>();
		const get = this.db.prepare(
			"SELECT c.rowid AS rowid, c.doc_id AS doc_id, c.page AS page, c.title AS title, c.heading AS heading, c.content AS content, d.collection AS collection FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.rowid = ?",
		);
		for (const rowid of rowids) {
			const r = get.get(rowid) as
				| { rowid: number; doc_id: string; page: number | null; title: string; heading: string; content: string; collection: Collection }
				| undefined;
			if (!r) continue;
			const text = r.content.replace(/\s+/g, " ").trim();
			out.set(rowid, {
				chunk: r.rowid,
				docId: r.doc_id,
				title: r.title,
				collection: r.collection,
				page: r.page,
				heading: r.heading,
				snippet: text.length > 360 ? `${text.slice(0, 360)}…` : text,
			});
		}
		return out;
	}

	/** Full text of chunks by rowid. */
	chunkTexts(rowids: number[]): Map<number, string> {
		const get = this.db.prepare("SELECT content FROM chunks WHERE rowid = ?");
		const out = new Map<number, string>();
		for (const rowid of rowids) {
			const r = get.get(rowid) as { content: string } | undefined;
			if (r) out.set(rowid, r.content);
		}
		return out;
	}

	search(query: string, options: { limit?: number; collection?: Collection; shelves?: ShelfFilter } = {}): SearchHit[] {
		const plan = planQuery(query);
		if (!plan.terms.length) return [];
		const limit = options.limit ?? 8;
		const shelves = this.shelfSql(options.shelves);
		const filter = `${options.collection ? "AND d.collection = ?" : ""} ${shelves.sql}`;
		const extra = [...(options.collection ? [options.collection] : []), ...shelves.params];
		type Row = Candidate & { doc_id: string; page: number | null; collection: Collection; rowid: number };
		const rows = new Map<number, Row>();
		const select = "c.rowid, c.doc_id, c.page, c.title, c.heading, c.content, d.collection";
		if (plan.match) {
			const matched = this.db
				.prepare(
					`SELECT ${select}, bm25(chunks, 0, 0, 3, 2, 1) AS bm25
           FROM chunks c JOIN docs d ON d.id = c.doc_id
           WHERE chunks MATCH ? ${filter} ORDER BY bm25 LIMIT 200`,
				)
				.all(plan.match, ...extra) as unknown as Row[];
			for (const r of matched) rows.set(r.rowid, r);
		}
		// Terms under three characters cannot use the trigram index; scan with LIKE.
		for (const term of plan.short) {
			const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
			const matched = this.db
				.prepare(
					`SELECT ${select}, 0 AS bm25 FROM chunks c JOIN docs d ON d.id = c.doc_id
           WHERE (c.content LIKE ?1 ESCAPE '\\' OR c.heading LIKE ?1 ESCAPE '\\' OR c.title LIKE ?1 ESCAPE '\\') ${filter}
           LIMIT 200`,
				)
				.all(like, ...extra) as unknown as Row[];
			for (const r of matched) if (!rows.has(r.rowid)) rows.set(r.rowid, r);
		}
		const scored = [...rows.values()].map((r) => {
			const terms = termScores(plan, r);
			return { row: r, score: score(plan, r), terms, coverage: terms.reduce((sum, t) => sum + t, 0) / (terms.length || 1) };
		});
		// Terms found anywhere in each document: a page may hold one word and the next page the other.
		const docTerms = new Map<string, number[]>();
		for (const x of scored) {
			const best = docTerms.get(x.row.doc_id);
			docTerms.set(x.row.doc_id, best ? best.map((b, i) => Math.max(b, x.terms[i])) : x.terms);
		}
		const docCoverage = (docId: string) => {
			const terms = docTerms.get(docId) ?? [];
			return terms.reduce((sum, t) => sum + t, 0) / (terms.length || 1);
		};
		const over = (c: number) => c > MIN_COVERAGE + 1e-9;
		return scored
			// One word out of two is not a match, unless the document holds the other word too.
			.filter(
				(x) =>
					x.score > 0 &&
					(plan.terms.length < 2 || over(x.coverage) || (x.coverage >= MIN_COVERAGE - 1e-9 && over(docCoverage(x.row.doc_id)))),
			)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(({ row, score }) => ({
				chunk: row.rowid,
				docId: row.doc_id,
				title: row.title,
				collection: row.collection,
				page: row.page,
				heading: row.heading,
				snippet: snippet(plan, row.content),
				score,
			}));
	}
}
