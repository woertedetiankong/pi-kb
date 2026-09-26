import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	// Two words: one alone is not a match, but words on different pages of one document are.
	assert.equal(kb.search("CTRL_REG 恋爱").length, 0, "the other word is nowhere");
	const split = kb.search("供电电压 寄存器");
	assert.deepEqual(
		split.filter((h) => h.title === "xr100-manual.pdf").map((h) => h.page).sort(),
		[1, 2],
		"page 1 has one word, page 2 the other",
	);
	assert.doesNotMatch(kb.read(hit.docId, "2").text, /供电/);
});

test("OCRs Chinese text in images", async () => {
	const result = await kb.addFile(join(fixtures, "scan-note.png"));
	assert.equal(result.status, "added", result.message);
	assert.equal(result.doc?.kind, "image");
	// Tesseract often reorders Chinese words within a line, so assert on stable terms only.
	const read = kb.read(result.doc?.id ?? "");
	assert.match(read.text, /电气特性/);
	assert.ok(kb.search("电气特性").some((hit) => hit.title === "scan-note.png"));

	// How much text came from OCR is kept in the converted file, not shown as text or indexed.
	assert.match(readFileSync(join(root, "converted", `${result.doc?.id}.md`), "utf8"), /^<!-- kb:ocr (\d+)\/\1 -->$/m);
	assert.doesNotMatch(read.text, /kb:ocr/);
	assert.equal(read.ocr.length, 1);
	assert.equal(read.ocr[0].chars, read.ocr[0].total);
	assert.equal(kb.search("kb:ocr").length, 0);
	const pdf = kb.search("供电电压").find((hit) => hit.title === "xr100-manual.pdf")!;
	assert.deepEqual(kb.read(pdf.docId, "1-2").ocr, [], "native PDF text");

	// A drawing with a few OCR'd labels: page reads report the share and hide the line too.
	const outline = await kb.addFile(join(import.meta.dirname, "../scripts/model-check/corpus/xr100-outline.pdf"));
	const page = kb.read(outline.doc?.id ?? "", "1");
	assert.doesNotMatch(page.text, /kb:ocr/);
	assert.equal(page.ocr[0]?.page, 1);
	assert.ok(page.ocr[0].chars > 0 && page.ocr[0].chars < page.ocr[0].total / 2, JSON.stringify(page.ocr));
	kb.remove(outline.doc?.id ?? "");
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

test("renders pages of PDFs and images from the original for viewing", async () => {
	const pdf = kb.search("供电电压").find((hit) => hit.title === "xr100-manual.pdf")!;
	const { images } = await kb.renderPages(pdf.docId, "1-5", 4);
	assert.deepEqual(images.map((i) => i.page), [1, 2], "clamped to the last page");
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	assert.ok(images.every((i) => i.png.subarray(0, 4).equals(png)));

	const scan = kb.search("电气特性").find((hit) => hit.title === "scan-note.png")!;
	const single = await kb.renderPages(scan.docId, undefined, 4);
	assert.equal(single.images.length, 1, "an image is its one page");

	await assert.rejects(kb.renderPages(pdf.docId, undefined, 4), /Say which pages/);
	await assert.rejects(kb.renderPages(pdf.docId, "1-2", 1), /at most 1 pages/);
	const note = kb.search("CTRL_REG", { collection: "wiki" })[0];
	await assert.rejects(kb.renderPages(note.docId, undefined, 4), /text only/);
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
