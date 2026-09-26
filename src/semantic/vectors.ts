import type { DatabaseSync as Database } from "node:sqlite";
import type { Collection } from "../store.ts";

export const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
  chunk_rowid INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_doc ON vectors(doc_id);
`;

export interface PendingChunk {
	rowid: number;
	docId: string;
	text: string;
}

export interface VectorHit {
	rowid: number;
	/** Cosine similarity, -1..1. */
	score: number;
}

/** Embedding input: enough context to place the chunk, capped near the models' 512-token window. */
const passage = (title: string, heading: string, content: string) => [title, heading, content].filter(Boolean).join("\n").slice(0, 2000);

/**
 * Chunk vectors in SQLite, searched by brute force over an in-memory matrix. A personal
 * knowledge base of tens of thousands of chunks scores in milliseconds, without a vector extension.
 */
export class VectorIndex {
	private readonly db: Database;
	private cache?: { model: string; signature: string; rowids: Int32Array; collections: Collection[]; docIds: string[]; dim: number; data: Float32Array };

	constructor(db: Database) {
		this.db = db;
		db.exec(VECTOR_SCHEMA);
	}

	/** Chunks with no vector for this model yet, oldest first. */
	pending(model: string, limit: number): PendingChunk[] {
		const rows = this.db
			.prepare(
				`SELECT c.rowid AS rowid, c.doc_id AS docId, c.title AS title, c.heading AS heading, c.content AS content
         FROM chunks c LEFT JOIN vectors v ON v.chunk_rowid = c.rowid AND v.model = ?
         WHERE v.chunk_rowid IS NULL ORDER BY c.rowid LIMIT ?`,
			)
			.all(model, limit) as unknown as { rowid: number; docId: string; title: string; heading: string; content: string }[];
		return rows.map((r) => ({ rowid: r.rowid, docId: r.docId, text: passage(r.title, r.heading, r.content) }));
	}

	progress(model: string): { done: number; total: number } {
		const total = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
		const done = (this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE model = ?").get(model) as { n: number }).n;
		return { done, total };
	}

	/** Store vectors for chunks embedded from `text` (a PendingChunk's). */
	put(model: string, items: { rowid: number; docId: string; text: string; vector: Float32Array }[]): void {
		const insert = this.db.prepare("INSERT OR REPLACE INTO vectors (chunk_rowid, doc_id, model, vec) VALUES (?, ?, ?, ?)");
		this.db.exec("BEGIN");
		try {
			// A chunk may have been deleted or rewritten while it was being embedded. A rewritten chunk
			// can get the same rowid back (FTS5 reuses the highest ones), so compare the text too: a
			// vector of old text is dropped, the chunk stays pending and is embedded again.
			const live = this.db.prepare("SELECT title, heading, content FROM chunks WHERE rowid = ? AND doc_id = ?");
			for (const item of items) {
				const row = live.get(item.rowid, item.docId) as { title: string; heading: string; content: string } | undefined;
				if (!row || passage(row.title, row.heading, row.content) !== item.text) continue;
				insert.run(item.rowid, item.docId, model, new Uint8Array(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength));
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Drop vectors from other models (after switching provider) so they don't linger. */
	purgeOtherModels(model: string): number {
		return Number(this.db.prepare("DELETE FROM vectors WHERE model != ?").run(model).changes);
	}

	/** The `k` closest chunks, optionally only from one collection and from the documents in `allow`. */
	search(model: string, query: Float32Array, k: number, collection?: Collection, allow?: Set<string>): VectorHit[] {
		const m = this.matrix(model);
		if (!m || m.dim !== query.length) return [];
		const scores: VectorHit[] = [];
		for (let i = 0; i < m.rowids.length; i++) {
			if (collection && m.collections[i] !== collection) continue;
			if (allow && !allow.has(m.docIds[i])) continue;
			let dot = 0;
			const base = i * m.dim;
			for (let j = 0; j < m.dim; j++) dot += m.data[base + j] * query[j];
			scores.push({ rowid: m.rowids[i], score: dot });
		}
		return scores.sort((a, b) => b.score - a.score).slice(0, k);
	}

	/** Loads (or reuses) all vectors of a model as one Float32Array; reloads when rows change. */
	private matrix(model: string) {
		const sig = this.db
			.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(chunk_rowid), 0) AS s FROM vectors WHERE model = ?")
			.get(model) as { n: number; s: number };
		const signature = `${sig.n}:${sig.s}`;
		if (this.cache?.model === model && this.cache.signature === signature) return this.cache;
		if (!sig.n) return undefined;
		const rows = this.db
			.prepare("SELECT v.chunk_rowid AS rowid, v.doc_id AS docId, v.vec AS vec, d.collection AS collection FROM vectors v JOIN docs d ON d.id = v.doc_id WHERE v.model = ?")
			.all(model) as unknown as { rowid: number; docId: string; vec: Uint8Array; collection: Collection }[];
		const dim = rows.length ? rows[0].vec.byteLength / 4 : 0;
		const data = new Float32Array(rows.length * dim);
		const rowids = new Int32Array(rows.length);
		const collections: Collection[] = [];
		const docIds: string[] = [];
		rows.forEach((row, i) => {
			rowids[i] = row.rowid;
			collections.push(row.collection);
			docIds.push(row.docId);
			data.set(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)), i * dim);
		});
		this.cache = { model, signature, rowids, collections, docIds, dim, data };
		return this.cache;
	}
}
