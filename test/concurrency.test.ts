/**
 * Races found by the TLA+ models in specs/tla, reproduced on the real code.
 *
 * Each test drives the interleaving the model's counterexample found and checks the property it
 * violated: ImportVersions NoSilentDuplicates and ReplaceHonored, SemanticIndexer EventuallyIndexed
 * and NoStaleVector.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { DEFAULT_SEMANTIC } from "../src/config.ts";
import { createHub, type WebHub } from "../src/hub.ts";
import { KnowledgeBase } from "../src/kb.ts";
import { Library } from "../src/library.ts";
import { ImportQueue } from "../src/queue.ts";
import { KbWebApp } from "../src/web.ts";

const until = async (check: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 5));
	}
	return true;
};

// ---------------------------------------------------------------------------------------------
// Web uploads of new versions while earlier uploads wait in the import queue (ImportVersions.tla)

const TOKEN = "b".repeat(32);
let root: string;
let kb: KnowledgeBase;
let hub: WebHub;
let base: string;
/** Imports wait here while closed, like a long PDF conversion holds up the queue. */
let gate: { open: boolean; waiters: (() => void)[] };

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-kb-race-"));
	kb = new KnowledgeBase(root);
	gate = { open: true, waiters: [] };
	const queue = new ImportQueue(async (item, signal) => {
		if (!gate.open) await new Promise<void>((resolve) => gate.waiters.push(resolve));
		return kb.addFile(item.path, { ...item, signal });
	}, () => {});
	const app = new KbWebApp(
		{
			kb: () => kb,
			library: () => new Library(kb),
			enabled: () => true,
			setEnabled: () => {},
			changed: () => {},
			enqueue: (item) => queue.enqueue([item]),
			queued: () => queue.items(),
			importStatus: () => ({ ...queue.status, active: queue.active }),
			useLocal: async () => true,
			localSetup: () => ({}),
			forgetInstallError: () => {},
			model: () => undefined,
			location: () => ({ localDir: root, dir: root, source: "default" }),
			relocate: () => {},
		},
		join(import.meta.dirname, "..", "web", "kb.html"),
	);
	hub = createHub({ agentDir: root, token: TOKEN, port: 0 });
	hub.mount(app);
	await hub.start();
	base = new URL(hub.url("kb") ?? "").origin;
});
afterEach(async () => {
	gate.open = true;
	for (const w of gate.waiters.splice(0)) w();
	await hub.close();
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "x-token": TOKEN, ...(init.headers ?? {}) } });

/** POST /upload; returns the page's answer: { job } when queued, { versions } when it asks first. */
async function upload(name: string, body: string, query = ""): Promise<{ job?: number; versions?: string[] }> {
	const res = await call(`/api/kb/upload?name=${encodeURIComponent(name)}${query}`, { method: "POST", body });
	return res.json();
}

async function finished(job: number) {
	for (;;) {
		const r = await (await call(`/api/kb/import?job=${job}`)).json();
		if (r.done) return r.results[0];
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function holdImports() {
	gate.open = false;
}
function releaseImports() {
	gate.open = true;
	for (const w of gate.waiters.splice(0)) w();
}

test("a second version uploaded while the first is still queued is asked about", async () => {
	holdImports();
	const first = await upload("spec.md", "# Spec\n\nlimit 10 A");
	assert.ok(first.job, "queued");
	const second = await upload("spec.md", "# Spec\n\nlimit 12 A");
	releaseImports();
	if (second.job) await finished(second.job);
	await finished(first.job);
	// README: "importing a file ... again with changed content asks first".
	assert.deepEqual(
		Object.keys(second),
		["versions"],
		`not asked; the knowledge base now holds ${kb.store.listDocs("docs").map((d) => d.title).join(", ")}`,
	);
});

test("the same file uploaded again while still queued is not a new version", async () => {
	holdImports();
	const first = await upload("spec.md", "# Spec\n\nlimit 10 A");
	const again = await upload("spec.md", "# Spec\n\nlimit 10 A");
	assert.ok(again.job, "queued without asking");
	releaseImports();
	assert.equal((await finished(first.job!)).status, "added");
	assert.equal((await finished(again.job!)).status, "exists");
});

test("re-uploading an imported file while another version is queued is asked about", async () => {
	const v2 = await upload("spec.md", "# Spec\n\nlimit 12 A");
	await finished(v2.job!);
	holdImports();
	const v1 = await upload("spec.md", "# Spec\n\nlimit 10 A", "&onUpdate=replace");
	// v2 is imported, but the queued v1 will replace it before this upload runs.
	assert.deepEqual(Object.keys(await upload("spec.md", "# Spec\n\nlimit 12 A")), ["versions"]);
	releaseImports();
	await finished(v1.job!);
});

test("choosing Replace twice in a row leaves only the newest version", async () => {
	const v1 = await upload("spec.md", "# Spec\n\nlimit 10 A");
	await finished(v1.job!);

	holdImports();
	const v2 = await upload("spec.md", "# Spec\n\nlimit 12 A", "&onUpdate=replace");
	const v3 = await upload("spec.md", "# Spec\n\nlimit 15 A", "&onUpdate=replace");
	releaseImports();
	await finished(v2.job!);
	await finished(v3.job!);

	const docs = kb.store.listDocs("docs");
	assert.deepEqual(
		docs.map((d) => `${d.title}: ${kb.read(d.id).text.match(/limit \d+ A/)?.[0]}`),
		["spec.md: limit 15 A"],
	);
});

// ---------------------------------------------------------------------------------------------
// Background embedding (SemanticIndexer.tla), through KnowledgeBase with a fake embeddings API

let server: Server;
let apiUrl: string;
/** Requests for these models wait until released (or until the client aborts them). */
const held = new Set<string>();
const waiting: { model: string; release: () => void }[] = [];
const inputs: string[] = [];

/** One dimension per concept, as in semantic.test.ts. */
const CONCEPTS = [/voltage|volt/gi, /spi|clock|divider/gi];
const embedText = (text: string) => [...CONCEPTS.map((re) => (text.match(re) ?? []).length), 0.01];

before(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const { model, input } = JSON.parse(body) as { model: string; input: string[] };
			const answer = () => {
				inputs.push(...input);
				const data = input.map((text, index) => ({ index, embedding: embedText(text) }));
				if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
			};
			if (held.has(model)) waiting.push({ model, release: answer });
			else answer();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

function semanticKb() {
	const dir = mkdtempSync(join(tmpdir(), "pi-kb-race-sem-"));
	const k = new KnowledgeBase(dir);
	const use = (model: string) => k.updateConfig({ semantic: { ...DEFAULT_SEMANTIC, provider: "api", api: { baseUrl: apiUrl, model } } });
	const progress = (model: string) => k.vectors.progress(`api:${apiUrl}|${model}`);
	return { k, dir, use, progress };
}

test("switching the embedding model while a batch is in flight still indexes with the new model", async () => {
	const { k, dir, use, progress } = semanticKb();
	try {
		const note = join(dir, "lesson.md");
		writeFileSync(note, "# Lesson\n\nSPI clock divider must be set first.\n");
		await k.addFile(note, { wiki: true });

		held.add("model-a");
		use("model-a"); // applyChanges: use(A), kick(): the batch goes out and waits
		assert.ok(await until(() => waiting.some((w) => w.model === "model-a")), "model A's request is in flight");
		use("model-b"); // applyChanges: use(B) aborts A's loop, kick() only sets `again`

		const indexed = await until(() => progress("model-b").done === progress("model-b").total && progress("model-b").total > 0);
		assert.ok(indexed, `model B vectors ${progress("model-b").done}/${progress("model-b").total}, indexer ${k.indexer.status.state}`);
	} finally {
		held.clear();
		for (const w of waiting.splice(0)) w.release();
		k.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("editing a note while its old text is being embedded does not keep the old vector", async () => {
	const { k, dir, use, progress } = semanticKb();
	try {
		use("model-c");
		await k.indexSemantic();
		held.add("model-c");
		inputs.length = 0;

		const note = join(dir, "lesson.md");
		writeFileSync(note, "# Lesson\n\nThe supply voltage is 3.3 volt.\n");
		const added = await k.addFile(note, { wiki: true }); // indexWikiFile: putDoc, kick(): embedding starts
		assert.ok(await until(() => waiting.some((w) => w.model === "model-c")), "the old text's request is in flight");
		const rowidsBefore = k.store.db.prepare("SELECT rowid FROM chunks WHERE doc_id = ?").all(added.doc!.id).map((r) => r.rowid);

		k.editNote(added.doc!.id, "# Lesson\n\nSet the SPI clock divider first.\n"); // putDoc again, kick(): `again`
		const rowidsAfter = k.store.db.prepare("SELECT rowid FROM chunks WHERE doc_id = ?").all(added.doc!.id).map((r) => r.rowid);
		assert.deepEqual(rowidsAfter, rowidsBefore, "precondition: SQLite gave the new chunk the old rowid");

		held.clear();
		for (const w of waiting.splice(0)) w.release();
		await until(() => k.indexer.status.state === "idle" && progress("model-c").done === progress("model-c").total);
		await k.indexSemantic();

		assert.equal(progress("model-c").done, progress("model-c").total, "every chunk has a vector");
		assert.ok(
			inputs.some((text) => /divider/.test(text)),
			`the edited text was never embedded; only: ${JSON.stringify(inputs)}`,
		);
	} finally {
		held.clear();
		for (const w of waiting.splice(0)) w.release();
		k.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closing the knowledge base while a batch is in flight does not start the loop again", async () => {
	const { k, dir, use } = semanticKb();
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	process.on("unhandledRejection", onError);
	try {
		held.add("model-d");
		use("model-d");
		const note = join(dir, "lesson.md");
		writeFileSync(note, "# Lesson\n\nSPI clock divider first.\n");
		await k.addFile(note, { wiki: true }); // kick(): the batch goes out and waits
		assert.ok(await until(() => waiting.some((w) => w.model === "model-d")));
		writeFileSync(join(dir, "other.md"), "# Other\n\nsupply voltage\n");
		await k.addFile(join(dir, "other.md"), { wiki: true }); // kick() while running: `again`
		const running = k.indexer.kick();
		k.close(); // stop(): abort, and the kicks before it are dropped
		await running;
		assert.notEqual(k.indexer.status.state, "error", k.indexer.status.error);
		assert.deepEqual(errors, []);
	} finally {
		process.off("unhandledRejection", onError);
		held.clear();
		for (const w of waiting.splice(0)) w.release();
		rmSync(dir, { recursive: true, force: true });
	}
});
