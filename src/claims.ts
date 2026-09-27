import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Coordination between the pi windows (processes) on one computer, through small files in the
 * knowledge base's local folder: who works on what, and who is busy with work that takes every core.
 */

/** Whether a process with this id is running (a claim of a dead pi is up for grabs again). */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const owner = (file: string): number => {
	try {
		return Number(readFileSync(file, "utf8").split("-")[0]);
	} catch {
		return 0; // released meanwhile
	}
};

/**
 * Take a piece of work, so two pi windows don't both do it. A claim is a file holding its owner's
 * pid; a dead owner's claim, or this process's own (a pi that reloaded while working), is taken
 * over. Returns the claim's token, or undefined when another pi has it.
 */
export function claim(file: string): string | undefined {
	const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(file, token, { flag: "wx" });
		return token;
	} catch {
		// claimed before: see whose it is
	}
	const pid = owner(file);
	if (pid && pid !== process.pid && alive(pid)) return undefined;
	writeFileSync(file, token);
	return token;
}

/** Give a claim back, unless someone has taken it over since. */
export function release(file: string, token: string): void {
	try {
		if (readFileSync(file, "utf8") === token) rmSync(file, { force: true });
	} catch {
		// gone already
	}
}

/** Whether a running process holds one of the claims in `dir` whose name passes `filter`. */
export function anyClaimed(dir: string, filter: (name: string) => boolean = () => true): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	return names.some((name) => {
		if (!filter(name)) return false;
		const pid = owner(join(dir, name));
		return !!pid && alive(pid);
	});
}

/**
 * Mark a child process as busy in `dir` (a file named after its pid) until the returned function
 * is called. A process that dies unexpectedly leaves its file behind, and busy() ignores it.
 */
export function markBusy(dir: string, pid: number): () => void {
	const file = join(dir, String(pid));
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, String(pid));
	} catch {
		return () => {}; // the work goes on unmarked
	}
	return () => rmSync(file, { force: true });
}

/** Whether a process marked by markBusy in `dir` still runs; files of dead ones are removed. */
export function busy(dir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	let found = false;
	for (const name of names) {
		if (alive(Number(name))) found = true;
		else rmSync(join(dir, name), { force: true });
	}
	return found;
}

/** Wait `ms`; resolves false at once when `signal` aborts. The timer never keeps pi running. */
export function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const done = (ok: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(ok);
		};
		const abort = () => done(false);
		const timer = setTimeout(() => done(true), ms);
		timer.unref();
		signal?.addEventListener("abort", abort, { once: true });
	});
}
