import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";
import { type ImportItem, ImportQueue } from "../src/queue.ts";

/** An import that takes until released, and reports cancellation like addFile does. */
function slowImports() {
	const started: string[] = [];
	const release = new Map<string, () => void>();
	const importFn = (item: ImportItem, signal: AbortSignal) =>
		new Promise<import("../src/kb.ts").AddResult>((resolve) => {
			started.push(item.path);
			const done = () => resolve({ path: item.path, status: "added" });
			release.set(item.path, done);
			signal.addEventListener("abort", () => resolve({ path: item.path, status: "skipped", reason: "cancelled" }));
		});
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 1));
	};
	return { started, release, importFn, until };
}

test("imports files one at a time, jobs in order, and reports each job when done", async () => {
	const { started, release, importFn, until } = slowImports();
	const queue = new ImportQueue(importFn, () => {});
	const first = queue.enqueue([{ path: "a.pdf", wiki: false }, { path: "b.pdf", wiki: false }], [{ path: "x.doc", status: "skipped" }]);
	const second = queue.enqueue([{ path: "c.md", wiki: true }]);
	assert.equal(first.total, 3);
	await until(() => started.length === 1);
	assert.deepEqual(queue.status, { done: 0, total: 3, current: "a.pdf", startedAt: queue.status.startedAt });
	release.get("a.pdf")!();
	await until(() => started.length === 2);
	assert.equal(queue.status.done, 1);
	release.get("b.pdf")!();
	assert.deepEqual((await first.done).map((r) => `${r.path}:${r.status}`), ["x.doc:skipped", "a.pdf:added", "b.pdf:added"]);
	await until(() => started.length === 3);
	release.get("c.md")!();
	assert.deepEqual((await second.done).map((r) => r.path), ["c.md"]);
	await until(() => !queue.active);
	assert.deepEqual(queue.status, { done: 0, total: 0, current: undefined, startedAt: undefined });
});

test("a job with nothing to import is done at once", async () => {
	const queue = new ImportQueue(() => Promise.reject(new Error("not called")), () => {});
	const job = queue.enqueue([], [{ path: "missing.pdf", status: "failed", reason: "not_found" }]);
	assert.equal((await job.done).length, 1);
	assert.equal(queue.active, false);
});

test("cancel stops the current file, drops the queue, and later imports still run", async () => {
	const { started, release, importFn, until } = slowImports();
	const queue = new ImportQueue(importFn, () => {});
	const job = queue.enqueue(["a", "b", "c"].map((path) => ({ path, wiki: false })));
	await until(() => started.length === 1);
	assert.equal(queue.cancel(), 3);
	const results = await job.done;
	assert.deepEqual(results.map((r) => `${r.path}:${r.reason}`).sort(), ["a:cancelled", "b:cancelled", "c:cancelled"]);
	assert.deepEqual(started, ["a"], "queued files are never started");

	const again = queue.enqueue([{ path: "d", wiki: false }]);
	await until(() => started.includes("d"));
	release.get("d")!();
	assert.equal((await again.done)[0].status, "added");
	assert.equal(queue.cancel(), 0);
});

test("a failing import is reported and the queue carries on", async () => {
	const queue = new ImportQueue(async (item) => {
		if (item.path === "bad") throw new Error("boom");
		return { path: item.path, status: "added" };
	}, () => {});
	const results = await queue.enqueue(["bad", "good"].map((path) => ({ path, wiki: false }))).done;
	assert.deepEqual(results.map((r) => `${r.path}:${r.status}`), ["bad:failed", "good:added"]);
	assert.equal(results[0].message, "boom");
});

test("cancelling a PDF mid-conversion kills the parser and saves nothing", async () => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	const root = mkdtempSync(join(tmpdir(), "pi-kb-cancel-"));
	const kb = new KnowledgeBase(root);
	try {
		const controller = new AbortController();
		const pending = kb.addFile(join(import.meta.dirname, "fixtures", "xr100-manual.pdf"), { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await pending;
		assert.equal(result.status, "skipped");
		assert.equal(result.reason, "cancelled");
		assert.equal(kb.store.listDocs().length, 0);
		// The same file imports normally afterwards.
		assert.equal((await kb.addFile(join(import.meta.dirname, "fixtures", "xr100-manual.pdf"))).status, "added");
	} finally {
		kb.close();
		rmSync(root, { recursive: true, force: true });
	}
});
