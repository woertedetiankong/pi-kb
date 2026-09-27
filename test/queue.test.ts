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
	assert.deepEqual(queue.status, { done: 0, total: 3, current: "a.pdf", startedAt: queue.status.startedAt, note: undefined });
	release.get("a.pdf")!();
	await until(() => started.length === 2);
	assert.equal(queue.status.done, 1);
	release.get("b.pdf")!();
	assert.deepEqual((await first.done).map((r) => `${r.path}:${r.status}`), ["x.doc:skipped", "a.pdf:added", "b.pdf:added"]);
	await until(() => started.length === 3);
	release.get("c.md")!();
	assert.deepEqual((await second.done).map((r) => r.path), ["c.md"]);
	await until(() => !queue.active);
	assert.deepEqual(queue.status, { done: 0, total: 0, current: undefined, startedAt: undefined, note: undefined });
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

test("pending lists the file being imported, then the queue; a note from the import shows in the status", async () => {
	const { release, until } = slowImports();
	let note: ((n: "ocr_download") => void) | undefined;
	const queue = new ImportQueue(
		(item, _signal, report) =>
			new Promise((resolve) => {
				note = report;
				release.set(item.path, () => resolve({ path: item.path, status: "added" }));
			}),
		() => {},
	);
	queue.enqueue([{ path: "/x/a.pdf", wiki: false }, { path: "/x/b.png", wiki: false }]);
	await until(() => release.has("/x/a.pdf"));
	assert.deepEqual(queue.pending(), ["/x/a.pdf", "/x/b.png"]);
	note?.("ocr_download");
	assert.equal(queue.status.note, "ocr_download");
	release.get("/x/a.pdf")?.();
	await until(() => release.has("/x/b.png"));
	assert.equal(queue.status.note, undefined, "a note belongs to its file");
	assert.deepEqual(queue.pending(), ["/x/b.png"]);
	release.get("/x/b.png")?.();
	await until(() => !queue.active);
	assert.deepEqual(queue.pending(), []);
});

test("OCR data that cannot be downloaded fails the image instead of storing it empty, so it can be retried", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-ocr-offline-"));
	const saved = { tess: process.env.PI_KB_TESSDATA, proxy: process.env.HTTPS_PROXY, proxyLower: process.env.https_proxy };
	// An empty language data folder and a proxy nobody listens on: the parser cannot fetch eng.traineddata.
	process.env.PI_KB_TESSDATA = join(root, "tessdata");
	process.env.HTTPS_PROXY = process.env.https_proxy = "http://127.0.0.1:9";
	const kb = new KnowledgeBase(root);
	try {
		kb.updateConfig({ ocrLanguage: "eng" });
		const notes: (string | undefined)[] = [];
		const r = await kb.addFile(join(import.meta.dirname, "fixtures", "scan-note.png"), { onNote: (n) => notes.push(n) });
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "ocr_unavailable");
		assert.deepEqual(notes, ["ocr_download"], "the status bar says why the first OCR takes long");
		assert.equal(kb.store.listDocs().length, 0, "nothing stored, so a later import is a fresh attempt");
	} finally {
		kb.close();
		for (const [name, value] of [["PI_KB_TESSDATA", saved.tess], ["HTTPS_PROXY", saved.proxy], ["https_proxy", saved.proxyLower]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

/** Background work (OCR after imports) that takes until released, and says how it was stopped. */
function slowBackground(tasks: string[]) {
	const started: string[] = [];
	const aborted: string[] = [];
	const release = new Map<string, () => void>();
	const background = (signal: AbortSignal, _note: unknown, begin: (label: string) => void) =>
		new Promise<boolean>((resolve) => {
			const task = tasks[0];
			if (!task) return resolve(false);
			begin(task);
			started.push(task);
			release.set(task, () => {
				tasks.shift();
				resolve(true);
			});
			// Aborted: the task stays for next time, as an OCR'd document stays waiting.
			signal.addEventListener("abort", () => {
				aborted.push(task);
				resolve(true);
			});
		});
	return { started, aborted, release, background };
}

test("background work runs once imports are done, and an import goes before it", async () => {
	const imports = slowImports();
	const bg = slowBackground(["ocr a.pdf", "ocr b.pdf"]);
	const queue = new ImportQueue(imports.importFn, () => {}, bg.background);
	queue.kick();
	await imports.until(() => bg.started.length === 1);
	assert.equal(queue.active, false, "background work is not an import");
	assert.equal(queue.busy, true);
	assert.equal(queue.background?.current, "ocr a.pdf");

	// A new import stops the background work and goes first; the work starts over afterwards.
	const job = queue.enqueue([{ path: "c.pdf", wiki: false }]);
	await imports.until(() => imports.started.includes("c.pdf"));
	assert.deepEqual(bg.aborted, ["ocr a.pdf"]);
	assert.equal(queue.background, undefined);
	imports.release.get("c.pdf")!();
	await job.done;
	await imports.until(() => bg.started.length === 2);
	assert.deepEqual(bg.started, ["ocr a.pdf", "ocr a.pdf"]);
	bg.release.get("ocr a.pdf")!();
	await imports.until(() => bg.started.length === 3);
	bg.release.get("ocr b.pdf")!();
	await imports.until(() => !queue.busy);
	assert.equal(queue.background, undefined);
});

test("cancel stops background work until the next import", async () => {
	const imports = slowImports();
	const bg = slowBackground(["ocr a.pdf"]);
	const queue = new ImportQueue(imports.importFn, () => {}, bg.background);
	queue.kick();
	await imports.until(() => bg.started.length === 1);
	assert.equal(queue.cancel(), 0, "no file was left unimported");
	await imports.until(() => !queue.busy);
	queue.kick();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(bg.started.length, 1, "kick does not undo a cancel");

	const job = queue.enqueue([{ path: "d.pdf", wiki: false }]);
	await imports.until(() => imports.started.includes("d.pdf"));
	imports.release.get("d.pdf")!();
	await job.done;
	await imports.until(() => bg.started.length === 2);
	bg.release.get("ocr a.pdf")!();
	await imports.until(() => !queue.busy);
});

test("background work that fails unexpectedly stops instead of looping", async () => {
	let calls = 0;
	const queue = new ImportQueue(
		async (item) => ({ path: item.path, status: "added" }),
		() => {},
		async () => {
			calls++;
			throw new Error("boom");
		},
	);
	queue.kick();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(calls, 1);
	assert.equal(queue.busy, false);
});
