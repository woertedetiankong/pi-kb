import { join } from "node:path";
import { claim, pause, release } from "../claims.ts";
import { type DownloadProgress, type EmbeddingProvider, LocalProvider, SemanticError, type SemanticProblem } from "./providers.ts";
import type { VectorIndex } from "./vectors.ts";

export interface IndexerStatus {
	state: "off" | "idle" | "indexing" | "error";
	done: number;
	total: number;
	/** Model download in progress (local provider, first use). */
	download?: DownloadProgress;
	error?: string;
	problem?: SemanticProblem;
	/**
	 * Why no progress is made here: "reading" while files are read with OCR on this computer
	 * (a local model waits for it), "window" while another pi embeds this knowledge base.
	 */
	waiting?: "reading" | "window";
}

/** How pi windows on one computer take turns, see SemanticIndexer. */
export interface IndexerTurns {
	/** Folder of the claims saying which pi embeds which knowledge base. */
	claimDir: string;
	/** This knowledge base's name among them. */
	key: string;
	/** Whether a local model should wait: files are being read with OCR, which wants the same cores. */
	holdOff: () => boolean;
}

/** Claims of pis embedding with a local model on this computer's CPU (as opposed to an API). */
export const isLocalClaim = (name: string) => name.endsWith(".local");

/** How often a waiting indexer looks again: for OCR to finish, or for the pi embedding to go away. */
const HOLD_OFF_MS = 1000;
const OTHER_WINDOW_MS = 3000;

/**
 * Embeds chunks in the background, a batch at a time, so imports return as soon as the
 * text is searchable by keyword. Safe to kick repeatedly; one loop runs at a time.
 *
 * With `turns`, one pi on the computer embeds a knowledge base at a time; the others show its
 * progress (the vectors land in the same index) and take over if it goes away. A local model also
 * waits while files are read with OCR: each takes about half of the cores, together all of them.
 */
export class SemanticIndexer {
	status: IndexerStatus = { state: "off", done: 0, total: 0 };
	private readonly vectors: VectorIndex;
	private readonly onChange: (status: IndexerStatus) => void;
	private provider?: EmbeddingProvider;
	private running?: Promise<void>;
	private again = false;
	private aborter?: AbortController;
	private readonly turns?: IndexerTurns;

	constructor(vectors: VectorIndex, onChange: (status: IndexerStatus) => void, turns?: IndexerTurns) {
		this.vectors = vectors;
		this.onChange = onChange;
		this.turns = turns;
	}

	/** Switch provider (or turn off with undefined); stops the current loop. */
	/** Stops following a shared local model's download. */
	private unwatch?: () => void;

	use(provider: EmbeddingProvider | undefined): void {
		this.stop();
		this.unwatch?.();
		this.unwatch = undefined;
		this.provider = provider;
		if (provider instanceof LocalProvider) this.unwatch = provider.watchDownload((download) => this.update({ download }));
		if (!provider) return this.update({ state: "off", done: 0, total: 0, error: undefined, problem: undefined, download: undefined, waiting: undefined });
		this.vectors.purgeOtherModels(provider.key);
		this.update({ state: "idle", error: undefined, problem: undefined, waiting: undefined, ...this.vectors.progress(provider.key) });
	}

	/** Embed whatever is missing. Resolves when the queue is empty, failed or stopped. */
	kick(): Promise<void> {
		if (!this.provider) return Promise.resolve();
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				// A loop stopped early (another provider was chosen meanwhile) does not look at `again`;
				// start over for the current provider rather than drop that kick.
				do await this.loop();
				while (this.again && this.provider);
			} finally {
				this.running = undefined;
			}
		})();
		return this.running;
	}

	/** Stop the running loop. Kicks made before are dropped; kick again to start over. */
	stop(): void {
		this.again = false;
		this.aborter?.abort();
		this.aborter = undefined;
	}

	private async loop(): Promise<void> {
		const provider = this.provider;
		if (!provider) return;
		const aborter = new AbortController();
		this.aborter = aborter;
		// Local models run on this machine's CPU. Qwen3's memory grows with the batch (2.1 GB at 1 chunk,
		// 5.3 GB at 8) while throughput stays the same, so embed two at a time.
		const local = provider instanceof LocalProvider;
		const batch = local ? 2 : 32;
		const claimFile = this.turns && join(this.turns.claimDir, `${this.turns.key}${local ? ".local" : ""}`);
		let token: string | undefined;
		try {
			do {
				this.again = false;
				this.update({ state: "indexing", error: undefined, problem: undefined, ...this.vectors.progress(provider.key) });
				for (;;) {
					if (aborter.signal.aborted || this.provider !== provider) return;
					const pending = this.vectors.pending(provider.key, batch);
					if (!pending.length) break;
					// Taken when there is work, held until there is none left.
					if (claimFile && !token) token = claim(claimFile);
					const waiting = claimFile && !token ? "window" : local && this.turns?.holdOff() ? "reading" : undefined;
					if (waiting !== this.status.waiting || waiting === "window") this.update({ waiting, ...this.vectors.progress(provider.key) });
					if (waiting) {
						if (!(await pause(waiting === "window" ? OTHER_WINDOW_MS : HOLD_OFF_MS, aborter.signal))) return;
						continue;
					}
					const vectors = await provider.embed(
						pending.map((p) => p.text),
						"passage",
						aborter.signal,
					);
					if (aborter.signal.aborted || this.provider !== provider) return;
					this.vectors.put(
						provider.key,
						pending.map((p, i) => ({ rowid: p.rowid, docId: p.docId, text: p.text, vector: vectors[i] })),
					);
					this.update({ download: undefined, ...this.vectors.progress(provider.key) });
					await new Promise((resolve) => setImmediate(resolve));
				}
			} while (this.again);
			this.update({ state: "idle", waiting: undefined, ...this.vectors.progress(provider.key) });
		} catch (error) {
			if (aborter.signal.aborted) return;
			this.update({
				state: "error",
				error: error instanceof Error ? error.message : String(error),
				problem: error instanceof SemanticError ? error.problem : undefined,
				download: undefined,
				waiting: undefined,
			});
		} finally {
			if (claimFile && token) release(claimFile, token);
		}
	}

	private update(change: Partial<IndexerStatus>): void {
		this.status = { ...this.status, ...change };
		this.onChange(this.status);
	}
}
