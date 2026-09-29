import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { busy, claim, markBusy } from "../src/claims.ts";
import { indexFile, KnowledgeBase } from "../src/kb.ts";
import { type EmbeddingProvider, LocalProvider } from "../src/semantic/providers.ts";

/** A PDF with a text layer and a drawing whose labels only OCR reads. */
const outline = join(import.meta.dirname, "..", "scripts", "model-check", "corpus", "xr100-outline.pdf");
/** A process that runs as long as the tests: stands for another pi window. */
const otherPi = process.ppid;
let root: string;
let kb: KnowledgeBase;
/**
 * A waiting indexer or OCR loop never keeps the process running (so `pi -p` can exit); pi's
 * interface keeps it running, and this timer does here.
 */
let alive: NodeJS.Timeout;

before(async () => {
	alive = setInterval(() => {}, 1000);
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	root = mkdtempSync(join(tmpdir(), "pi-kb-turns-"));
	kb = new KnowledgeBase(root);
	const note = join(root, "lesson.md");
	writeFileSync(note, "# Lesson\n\nSPI clock divider must be set first.\n\n## Power\n\nThe core runs at 1.8 V.\n");
	assert.equal((await kb.addFile(note, { wiki: true })).status, "added");
});
after(() => {
	clearInterval(alive);
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

const until = async (check: () => boolean, ms = 8000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (check()) return true;
	return check();
};

/** Counts the texts it embeds. `local` makes it look like the model that runs on this computer's CPU. */
function fakeProvider(key: string, local: boolean) {
	const provider: EmbeddingProvider & { embedded: number } = local ? Object.create(LocalProvider.prototype) : {};
	return Object.assign(provider, {
		key,
		embedded: 0,
		batch: 2,
		watchDownload: () => () => {},
		async embed(texts: string[]) {
			provider.embedded += texts.length;
			return texts.map(() => new Float32Array([1, 0]));
		},
	});
}

const claimDir = () => join(root, "embed-claims");
/** This knowledge base's claim, as KnowledgeBase names it. */
const claimName = () => createHash("sha256").update(indexFile(root, root)).digest("hex").slice(0, 12);

test("claims: a running owner keeps its claim, a dead one's is taken over; busy marks of dead processes are dropped", () => {
	const file = join(root, "scratch-claims", "work");
	mkdirSync(join(root, "scratch-claims"), { recursive: true });
	writeFileSync(file, `${otherPi}-other`);
	assert.equal(claim(file), undefined);
	writeFileSync(file, "999999-gone");
	assert.ok(claim(file)?.startsWith(`${process.pid}-`));

	const dir = join(root, "scratch-busy");
	const unmark = markBusy(dir, otherPi);
	assert.equal(busy(dir), true);
	unmark();
	assert.equal(busy(dir), false);
	writeFileSync(join(dir, "999999"), "");
	assert.equal(busy(dir), false);
	assert.deepEqual(readdirSync(dir), [], "a dead process's mark is cleaned up");
});

test("one pi window embeds a knowledge base: another waits, shows the progress, and takes over when that pi goes away", async () => {
	const provider = fakeProvider("fake-api", false);
	mkdirSync(claimDir(), { recursive: true });
	writeFileSync(join(claimDir(), claimName()), `${otherPi}-other`);
	kb.indexer.use(provider);
	const indexing = kb.indexer.kick();
	assert.ok(await until(() => kb.indexer.status.waiting === "window"), `status ${JSON.stringify(kb.indexer.status)}`);
	assert.equal(kb.indexer.status.state, "indexing", "the page and status bar still show indexing");
	assert.equal(provider.embedded, 0, "the same chunks are not embedded twice");

	writeFileSync(join(claimDir(), claimName()), "999999-gone");
	await indexing;
	assert.ok(provider.embedded > 0);
	assert.equal(kb.indexer.status.state, "idle");
	assert.equal(kb.indexer.status.waiting, undefined);
	assert.equal(existsSync(join(claimDir(), claimName())), false, "the claim is given back once done");
	kb.indexer.use(undefined);
});

test("a local model waits while files are read with OCR; an API does not", async () => {
	const reading = join(root, "reading");
	const unmark = markBusy(reading, otherPi);
	try {
		const api = fakeProvider("fake-api-2", false);
		kb.indexer.use(api);
		await kb.indexer.kick();
		assert.ok(api.embedded > 0, "an API costs this computer nothing: no reason to wait");

		const local = fakeProvider("local:fake", true);
		kb.indexer.use(local);
		const indexing = kb.indexer.kick();
		assert.ok(await until(() => kb.indexer.status.waiting === "reading"), `status ${JSON.stringify(kb.indexer.status)}`);
		assert.equal(local.embedded, 0);
		assert.ok(existsSync(join(claimDir(), `${claimName()}.local`)), "it keeps its turn while it waits");
		unmark();
		await indexing;
		assert.ok(local.embedded > 0);
		assert.equal(kb.indexer.status.waiting, undefined);
	} finally {
		unmark();
		kb.indexer.use(undefined);
	}
});

test("OCR waits while a local model embeds, marks itself while it reads, and goes on once the model is done", async () => {
	const { doc } = await kb.addFile(outline);
	const id = doc!.id;
	try {
		// Another pi embedding with an API: nothing to wait for.
		writeFileSync(join(claimDir(), "someone-else"), `${otherPi}-other`);
		// Another pi embedding with a local model.
		writeFileSync(join(claimDir(), "someone-else.local"), `${otherPi}-other`);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		assert.equal(await kb.ocrNext({ signal: controller.signal }), undefined, "stopped while waiting");
		assert.deepEqual(kb.ocrPending().map((d) => d.id), [id], "not started: still waiting");

		// Another pi reads it while this one waits its turn: not read a second time.
		const waiting = kb.ocrNext();
		await new Promise((r) => setTimeout(r, 300));
		kb.store.setOcrPending(id, false);
		writeFileSync(join(claimDir(), "someone-else.local"), "999999-gone");
		let readAgain = false;
		const watchAgain = setInterval(() => (readAgain ||= busy(join(root, "reading"))), 20);
		assert.equal(await waiting, undefined);
		clearInterval(watchAgain);
		assert.equal(readAgain, false, "no OCR ran for a document another pi has read");
		kb.store.setOcrPending(id, true);

		let marked = false;
		const done = kb.ocrNext();
		const watch = setInterval(() => (marked ||= busy(join(root, "reading"))), 20);
		const result = await done;
		clearInterval(watch);
		assert.equal(result?.status, "updated", result?.message);
		assert.ok(marked, "the OCR run was marked, so embedding would have waited");
		assert.equal(busy(join(root, "reading")), false, "and unmarked when done");
	} finally {
		rmSync(claimDir(), { recursive: true, force: true });
		kb.remove(id);
	}
});
