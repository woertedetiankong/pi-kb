import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hasTextLayer } from "../src/convert.ts";
import { KnowledgeBase } from "../src/kb.ts";

const fixtures = join(import.meta.dirname, "fixtures");
/** A PDF with a text layer and a drawing whose labels only OCR reads. */
const outline = join(import.meta.dirname, "..", "scripts", "model-check", "corpus", "xr100-outline.pdf");
let root: string;
let kb: KnowledgeBase;

before(() => {
	// Share downloaded OCR language data between runs instead of fetching it per temp root.
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	root = mkdtempSync(join(tmpdir(), "pi-kb-two-step-"));
	kb = new KnowledgeBase(root);
});
after(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

const manifest = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, "docs", `${id}.json`), "utf8"));
/** Documents with chunks waiting to be embedded (under any model name: none has vectors here). */
const toEmbed = (base: KnowledgeBase) => new Set(base.vectors.pending("test-model", 10_000).map((c) => c.docId));

test("a PDF is searchable by its text layer at once, and its pictures are read by OCR afterwards", async () => {
	const added = await kb.addFile(outline);
	assert.equal(added.status, "added", added.message);
	const id = added.doc!.id;
	assert.deepEqual(kb.ocrPending().map((d) => d.id), [id]);
	assert.equal(manifest(root, id).ocr, "pending", "the folder says so too, for its copies elsewhere");
	assert.ok(kb.search("XR-100").some((h) => h.docId === id), "searchable before OCR");
	assert.ok(!toEmbed(kb).has(id), "not embedded twice: once OCR has replaced the text");

	const done = await kb.ocrNext();
	assert.equal(done?.status, "updated", done?.message);
	assert.deepEqual(kb.ocrPending(), []);
	assert.equal(manifest(root, id).ocr, undefined);
	assert.ok(kb.read(id, "1").ocr.length, "the drawing's labels came from OCR");
	assert.ok(toEmbed(kb).has(id), "embedded now");
	assert.equal(done?.doc?.added_at, added.doc?.added_at, "same document, same date");
	kb.remove(id);
});

test("a scan or an image has no text of its own and is read by OCR at once", async () => {
	assert.equal(hasTextLayer([{ page: 1, markdown: "  \n " }, { page: 2, markdown: "Figure 1" }]), false);
	assert.equal(hasTextLayer([{ page: 1, markdown: "x".repeat(200) }]), true);
	const image = await kb.addFile(join(fixtures, "scan-note.png"));
	assert.equal(image.status, "added", image.message);
	assert.deepEqual(kb.ocrPending(), []);
	assert.ok(kb.search("电气特性").length);
	kb.remove(image.doc!.id);
});

test("stopping OCR leaves the document waiting; another pi's claim is respected, a dead one's is not", async () => {
	const { doc } = await kb.addFile(outline);
	const id = doc!.id;
	const controller = new AbortController();
	const stopping = kb.ocrNext({ signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	assert.equal((await stopping)?.reason, "cancelled");
	assert.deepEqual(kb.ocrPending().map((d) => d.id), [id], "still waiting, to be read from the start");

	// The claims live with this machine's files, next to the index.
	const claims = join(root, "ocr-claims");
	mkdirSync(claims, { recursive: true });
	writeFileSync(join(claims, id), `${process.ppid}-other`);
	assert.equal(await kb.ocrNext(), undefined, "another running pi is reading it");
	writeFileSync(join(claims, id), "999999-gone");
	assert.equal((await kb.ocrNext())?.status, "updated", "a claim of a pi that died is taken over");
	assert.equal(existsSync(join(claims, id)), false, "the claim is given back");
	kb.remove(id);
});

test("reading a document again, or removing it, settles its OCR", async () => {
	const first = await kb.addFile(outline);
	const again = await kb.reread(first.doc!.id);
	assert.equal(again.status, "updated", again.message);
	assert.deepEqual(kb.ocrPending(), [], "read in full, pictures and all");

	kb.remove(first.doc!.id);
	const second = await kb.addFile(outline);
	const reading = kb.ocrNext();
	kb.remove(second.doc!.id);
	assert.equal((await reading)?.status, "skipped", "removed meanwhile: not brought back");
	assert.equal(kb.store.getDoc(second.doc!.id), undefined);
	assert.equal(existsSync(join(root, "docs", `${second.doc!.id}.json`)), false, "no description left behind");
	assert.deepEqual(kb.ocrPending(), []);
});

test("a copy of the folder follows: waiting where the original is, updated once OCR is done elsewhere", async () => {
	const { doc } = await kb.addFile(outline);
	const id = doc!.id;
	// Another computer syncing the same content folder, with its own index.
	const elsewhere = new KnowledgeBase(mkdtempSync(join(tmpdir(), "pi-kb-two-step-local-")), { dir: root });
	// And a project clone without raw/ (not in git by default).
	const clone = mkdtempSync(join(tmpdir(), "pi-kb-two-step-clone-"));
	for (const part of ["docs", "converted"]) cpSync(join(root, part), join(clone, part), { recursive: true });
	const teammate = new KnowledgeBase(clone);
	try {
		elsewhere.sync();
		teammate.sync();
		assert.deepEqual(elsewhere.ocrPending().map((d) => d.id), [id]);
		assert.deepEqual(teammate.ocrPending(), [], "no original to read: the text layer is what there is");
		assert.ok(toEmbed(teammate).has(id));

		await kb.ocrNext();
		elsewhere.sync();
		assert.deepEqual(elsewhere.ocrPending(), []);
		assert.ok(elsewhere.read(id, "1").ocr.length, "the OCR'd text arrived");
		assert.ok(toEmbed(elsewhere).has(id));
	} finally {
		for (const base of [elsewhere, teammate]) {
			base.close();
			rmSync(base.localDir, { recursive: true, force: true });
		}
		kb.remove(id);
	}
});
