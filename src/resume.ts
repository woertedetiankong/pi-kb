import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ImportItem } from "./queue.ts";

/**
 * Imports that pi stopped in the middle of (quit, /reload, /new, /resume), picked up again by the
 * next pi that starts. Each stop writes a batch folder of its own, so windows closing together
 * don't overwrite each other, and a starting pi claims a batch by renaming it, so two starting
 * together don't both import it. A batch is written under a temporary name and renamed when
 * complete, so it is never claimed half-written; a claimed batch whose pi died is claimed again.
 *
 *   <localDir>/pending-imports/<batch>/items.json   the items, in queue order
 *   <localDir>/pending-imports/<batch>/files/…      copies of web uploads (their temp folder goes away)
 */

/** A queued item, plus the project it was going to when its scope is "project". */
export interface PendingItem extends ImportItem {
	projectDir?: string;
	/** Saved: `path` is the upload's copy, relative to the batch folder. */
	copied?: boolean;
}

export interface PendingBatch {
	/** Remove once its items are imported (or put back). */
	dir: string;
	items: PendingItem[];
}

const pendingRoot = (localDir: string) => join(localDir, "pending-imports");

/** Write the items still to import. Web uploads are copied, since their files are deleted when the queue lets go of them. */
export function savePending(localDir: string, items: PendingItem[]): void {
	if (!items.length) return;
	const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = join(pendingRoot(localDir), `${name}.writing`);
	mkdirSync(dir, { recursive: true });
	const saved = items.flatMap((item, i) => {
		if (!item.source?.startsWith("upload:")) return [item];
		if (!existsSync(item.path)) return [];
		// Relative to the batch, which is renamed when complete and again when claimed.
		const copy = join("files", String(i), basename(item.path));
		mkdirSync(join(dir, "files", String(i)), { recursive: true });
		copyFileSync(item.path, join(dir, copy));
		return [{ ...item, path: copy, copied: true }];
	});
	writeFileSync(join(dir, "items.json"), `${JSON.stringify(saved, null, 2)}\n`);
	renameSync(dir, join(pendingRoot(localDir), name));
}

/** Whether a process with this id is running (a claimed batch of a dead pi is up for grabs again). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Take every saved batch for this pi; another pi starting at the same time gets none of them. */
export function claimPending(localDir: string): PendingBatch[] {
	const root = pendingRoot(localDir);
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const batches: PendingBatch[] = [];
	for (const name of names.sort()) {
		if (name.endsWith(".writing")) continue;
		const [base, owner] = name.split(".claimed-");
		if (owner && (Number(owner) === process.pid || alive(Number(owner)))) continue;
		const dir = join(root, `${base}.claimed-${process.pid}`);
		try {
			renameSync(join(root, name), dir);
		} catch {
			continue; // claimed by another pi first
		}
		try {
			const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8"));
			if (Array.isArray(items)) batches.push({ dir, items: items.map(({ copied, ...item }: PendingItem) => (copied ? { ...item, path: join(dir, item.path) } : item)) });
			else rmSync(dir, { recursive: true, force: true });
		} catch {
			rmSync(dir, { recursive: true, force: true }); // still being written by a pi that crashed, or broken
		}
	}
	return batches;
}

export function dropBatch(batch: PendingBatch): void {
	rmSync(batch.dir, { recursive: true, force: true });
}
