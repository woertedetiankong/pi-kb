import type { AddResult } from "./kb.ts";

export interface ImportItem {
	path: string;
	/** Import Markdown as a wiki note. */
	wiki: boolean;
}

/** One /kb add or kb_add call: its files are imported in order, after earlier jobs. */
export interface ImportJob {
	/** Results so far, starting with files skipped before queueing (not found, unsupported). */
	readonly results: AddResult[];
	readonly total: number;
	/** Resolves with every result once the job's last file is done or cancelled. */
	readonly done: Promise<AddResult[]>;
}

export interface ImportStatus {
	/** Files finished and queued since the queue was last idle. */
	done: number;
	total: number;
	/** File being converted, and when it started (ms since epoch). */
	current?: string;
	startedAt?: number;
}

interface QueuedJob extends ImportJob {
	items: ImportItem[];
	finish: () => void;
}

export type ImportFn = (item: ImportItem, signal: AbortSignal) => Promise<AddResult>;

/**
 * Imports files one at a time in the background, so /kb add returns at once and
 * a long manual does not hold up the conversation. Conversion runs in a child
 * process (see runParse in convert.ts), so pi stays responsive meanwhile.
 *
 * Cancelling drops queued files and kills the conversion in progress; files that
 * finished before are kept.
 */
export class ImportQueue {
	private readonly jobs: QueuedJob[] = [];
	private readonly importFn: ImportFn;
	private readonly onChange: () => void;
	private running = false;
	private done = 0;
	private total = 0;
	private current?: { path: string; startedAt: number; controller: AbortController };

	constructor(importFn: ImportFn, onChange: () => void) {
		this.importFn = importFn;
		this.onChange = onChange;
	}

	get active(): boolean {
		return this.running;
	}

	get status(): ImportStatus {
		return { done: this.done, total: this.total, current: this.current?.path, startedAt: this.current?.startedAt };
	}

	enqueue(items: ImportItem[], skipped: AddResult[] = []): ImportJob {
		let finish!: () => void;
		const results = [...skipped];
		const done = new Promise<AddResult[]>((resolve) => (finish = () => resolve(results)));
		const job: QueuedJob = { results, total: skipped.length + items.length, done, items: [...items], finish };
		if (!items.length) {
			job.finish();
			return job;
		}
		this.jobs.push(job);
		this.total += items.length;
		if (!this.running) void this.run();
		else this.onChange();
		return job;
	}

	/** Drop every queued file and stop the one being converted. Returns how many files were not imported. */
	cancel(): number {
		let dropped = 0;
		for (const job of this.jobs) {
			for (const item of job.items.splice(0)) {
				job.results.push({ path: item.path, status: "skipped", reason: "cancelled", message: "import cancelled" });
				dropped++;
			}
		}
		this.total -= dropped;
		if (this.current) {
			this.current.controller.abort();
			dropped++;
		}
		this.onChange();
		return dropped;
	}

	private async run(): Promise<void> {
		this.running = true;
		this.onChange();
		while (this.jobs.length) {
			const job = this.jobs[0];
			const item = job.items.shift();
			if (!item) {
				this.jobs.shift();
				job.finish();
				continue;
			}
			const controller = new AbortController();
			this.current = { path: item.path, startedAt: Date.now(), controller };
			this.onChange();
			let result: AddResult;
			try {
				result = await this.importFn(item, controller.signal);
			} catch (error) {
				result = { path: item.path, status: "failed", message: error instanceof Error ? error.message : String(error) };
			}
			this.current = undefined;
			job.results.push(result);
			this.done++;
			this.onChange();
		}
		this.running = false;
		this.done = this.total = 0;
		this.onChange();
	}
}
