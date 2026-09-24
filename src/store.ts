import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { Chunk } from "./chunk.ts";
import { type Candidate, coverage, MIN_COVERAGE, planQuery, score, snippet } from "./search.ts";
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
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  doc_id UNINDEXED, page UNINDEXED, title, heading, content,
  tokenize = 'trigram'
);
`;

export class Store {
	readonly db: Database;

	constructor(file: string) {
		const { DatabaseSync } = loadSqlite();
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

	search(query: string, options: { limit?: number; collection?: Collection } = {}): SearchHit[] {
		const plan = planQuery(query);
		if (!plan.terms.length) return [];
		const limit = options.limit ?? 8;
		const filter = options.collection ? "AND d.collection = ?" : "";
		const extra = options.collection ? [options.collection] : [];
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
           WHERE (c.content LIKE ?1 ESCAPE '\\' OR c.heading LIKE ?1 ESCAPE '\\' OR c.title LIKE ?1 ESCAPE '\\') ${filter.replace("?", "?2")}
           LIMIT 200`,
				)
				.all(like, ...extra) as unknown as Row[];
			for (const r of matched) if (!rows.has(r.rowid)) rows.set(r.rowid, r);
		}
		return [...rows.values()]
			.map((r) => ({ row: r, score: score(plan, r), coverage: coverage(plan, r) }))
			// One common word out of several is not a match.
			.filter((x) => x.score > 0 && (plan.terms.length < 2 || x.coverage >= MIN_COVERAGE))
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
