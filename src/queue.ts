import type { AddResult } from "./kb.ts";

export interface ImportItem {
	path: string;
	/** Import Markdown as a wiki note. */
	wiki: boolean;
	/** Recorded origin when it is not the path, e.g. "upload:manual.pdf" for web uploads. */
	source?: string;
	/** Replace the earlier versions of this file when it is imported (decided then, not now). */
	replace?: boolean;
	/** Which knowledge base it goes into; global when unset. */
	scope?: "project" | "global";
	/** Not a new file: convert this document again from its original (`path`), e.g. after the OCR settings changed. */
	reread?: string;
	/** Shelves of the global knowledge base to put it on (ignored in a project's). */
	shelves?: string[];
	/** A note an agent imported with nobody to review it (see KnowledgeBase.addFile). */
	unreviewed?: boolean;
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
	/** Why the current file takes long, e.g. the first OCR downloading language data. */
	note?: ImportNote;
}

export type ImportNote = "ocr_download";

interface QueuedJob extends ImportJob {
	items: ImportItem[];
	finish: () => void;
}

/** `note` tells the queue why the current file takes long, for the status bar and the page. */
export type ImportFn = (item: ImportItem, signal: AbortSignal, note: (note: ImportNote | undefined) => void) => Promise<AddResult>;

/**
 * Work done while no import waits: reading the pictures of documents imported by their text layer
 * (OCR). Calls `started` with what it works on; resolves true when it did something (there may be
 * more), false when nothing was left. An import queued meanwhile aborts it, to go first.
 */
export type BackgroundFn = (
	signal: AbortSignal,
	note: (note: ImportNote | undefined) => void,
	started: (label: string) => void,
) => Promise<boolean>;

export interface BackgroundStatus {
	/** What it works on, e.g. a document's title, and since when (ms since epoch). */
	current: string;
	startedAt: number;
	note?: ImportNote;
}

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
	private readonly backgroundFn?: BackgroundFn;
	/** Background work in progress. */
	private bg?: { controller: AbortController; current?: string; startedAt?: number; note?: ImportNote };
	/** Cancelled: no background work until the next import. */
	private paused = false;
	private running = false;
	private done = 0;
	private total = 0;
	private current?: { item: ImportItem; path: string; startedAt: number; controller: AbortController; note?: ImportNote };

	constructor(importFn: ImportFn, onChange: () => void, background?: BackgroundFn) {
		this.importFn = importFn;
		this.onChange = onChange;
		this.backgroundFn = background;
	}

	/** Files are being imported (not counting background work). */
	get active(): boolean {
		return !!this.current || this.jobs.length > 0;
	}

	/** Importing or doing background work. */
	get busy(): boolean {
		return this.running;
	}

	/** The background work in progress, once it has said what it works on. */
	get background(): BackgroundStatus | undefined {
		const bg = this.bg;
		return bg?.current ? { current: bg.current, startedAt: bg.startedAt ?? Date.now(), note: bg.note } : undefined;
	}

	/** Start background work if nothing runs, e.g. documents left waiting by an earlier pi. */
	kick(): void {
		if (!this.running && this.backgroundFn && !this.paused) void this.run();
	}

	get status(): ImportStatus {
		return { done: this.done, total: this.total, current: this.current?.path, startedAt: this.current?.startedAt, note: this.current?.note };
	}

	/** Files not imported yet: the one being converted first, then the queue. */
	pending(): string[] {
		return [...(this.current ? [this.current.path] : []), ...this.jobs.flatMap((job) => job.items.map((item) => item.path))];
	}

	/** Items not imported yet, the one being converted first: nothing of them is in the knowledge base. */
	items(): ImportItem[] {
		return [...(this.current ? [this.current.item] : []), ...this.jobs.flatMap((job) => job.items)];
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
		this.paused = false;
		// Imports go first; the background work starts over once they are done.
		this.bg?.controller.abort();
		if (!this.running) void this.run();
		else this.onChange();
		return job;
	}

	/**
	 * Drop every queued file and stop the one being converted, and the background work until the next
	 * import. Returns how many files were not imported.
	 */
	cancel(): number {
		this.paused = true;
		this.bg?.controller.abort();
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
		for (;;) {
			if (!this.jobs.length) {
				this.done = this.total = 0;
				const worked = this.backgroundFn && !this.paused && (await this.runBackground());
				// Imports queued meanwhile go on; otherwise the queue rests until the next one.
				if (!worked && !this.jobs.length) break;
				continue;
			}
			const job = this.jobs[0];
			const item = job.items.shift();
			if (!item) {
				this.jobs.shift();
				job.finish();
				continue;
			}
			const controller = new AbortController();
			const current: NonNullable<typeof this.current> = { item, path: item.path, startedAt: Date.now(), controller };
			this.current = current;
			this.onChange();
			let result: AddResult;
			try {
				result = await this.importFn(item, controller.signal, (note) => {
					current.note = note;
					this.onChange();
				});
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

	private async runBackground(): Promise<boolean> {
		const bg: NonNullable<typeof this.bg> = { controller: new AbortController() };
		this.bg = bg;
		try {
			return await this.backgroundFn!(
				bg.controller.signal,
				(note) => {
					bg.note = note;
					this.onChange();
				},
				(current) => {
					Object.assign(bg, { current, startedAt: Date.now(), note: undefined });
					this.onChange();
				},
			);
		} catch {
			return false; // unexpected: stop rather than try again in a loop
		} finally {
			this.bg = undefined;
			this.onChange();
		}
	}
}
