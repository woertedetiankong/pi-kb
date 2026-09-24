import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";

const fixtures = join(import.meta.dirname, "fixtures");
let root: string;
let kb: KnowledgeBase;

before(() => {
	// Share downloaded OCR language data between runs instead of fetching it per temp root.
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	root = mkdtempSync(join(tmpdir(), "pi-kb-"));
	kb = new KnowledgeBase(root);
});
after(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

test("imports a PDF once and cites its pages", async () => {
	const first = await kb.addFile(join(fixtures, "xr100-manual.pdf"));
	assert.equal(first.status, "added", first.message);
	assert.equal(first.doc?.pages, 2);
	assert.equal((await kb.addFile(join(fixtures, "xr100-manual.pdf"))).status, "exists");

	const [hit] = kb.search("供电电压");
	assert.equal(hit.title, "xr100-manual.pdf");
	assert.equal(hit.page, 1);
	assert.equal(kb.search("CTRL_REG 地址")[0].page, 2);
	assert.equal(kb.search("芯片的供电电压范围是多少")[0].page, 1);
	assert.match(kb.read(hit.docId, "2").text, /CTRL_REG/);
	assert.doesNotMatch(kb.read(hit.docId, "2").text, /供电/);
});

test("OCRs Chinese text in images", async () => {
	const result = await kb.addFile(join(fixtures, "scan-note.png"));
	assert.equal(result.status, "added", result.message);
	assert.equal(result.doc?.kind, "image");
	// Tesseract often reorders Chinese words within a line, so assert on stable terms only.
	assert.match(kb.read(result.doc?.id ?? "").text, /电气特性/);
	assert.ok(kb.search("电气特性").some((hit) => hit.title === "scan-note.png"));
});

test("markdown notes become wiki notes and follow manual edits", async () => {
	const result = await kb.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
	assert.equal(result.doc?.collection, "wiki");
	assert.equal(result.doc?.title, "SPI 时钟分频踩坑");
	assert.equal(kb.search("CTRL_REG", { collection: "wiki" }).length, 1);

	appendFileSync(join(root, "wiki", "spi-lesson.md"), "\n补充：DMA 模式下同样需要分频。\n");
	writeFileSync(join(root, "wiki", "new-note.md"), "# 新经验\n\n烧录前先擦除扇区。\n");
	assert.deepEqual(kb.syncWiki(), { updated: 2, removed: 0 });
	assert.equal(kb.search("DMA 模式")[0].collection, "wiki");
	assert.match(kb.catalog(), /新经验/);

	rmSync(join(root, "wiki", "new-note.md"));
	assert.deepEqual(kb.syncWiki(), { updated: 0, removed: 1 });
});

test("collectFiles walks folders and reports unsupported files", () => {
	const { files, skipped } = kb.collectFiles([fixtures, join(fixtures, "nope.xyz")], "/");
	assert.equal(files.length, 3);
	assert.equal(skipped[0].status, "failed");
});

test("remove deletes the document and its index entries", async () => {
	for (const hit of kb.search("供电电压")) kb.remove(hit.docId);
	assert.equal(kb.search("供电电压").length, 0);
	assert.equal(kb.store.stats().docs, 0);
});
