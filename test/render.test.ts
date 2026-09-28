import assert from "node:assert/strict";
import { test } from "node:test";
import { messages } from "../src/i18n.ts";
import { addResult, listCall, listResult, plainSnippet, readCall, readResult, searchCall, searchResult, type Style } from "../src/render.ts";

/** No colors: what the user reads. */
const plain: Style = { fg: (_c, text) => text, bold: (text) => text };
const en = messages("en");
const zh = messages("zh");
const hit = (title: string, page: number | null, collection: "docs" | "wiki" = "docs", snippet = "") => ({ title, page, collection, snippet });

test("a search shows what it looked for and, in one line, where the answers are", () => {
	assert.equal(searchCall(plain, en, { query: "BMI270 I2C address" }), '📚 KB search "BMI270 I2C address"');
	assert.equal(searchCall(plain, en, { query: "SPI", scope: "wiki", shelf: "STM32" }), '📚 KB search "SPI" · notes only · collection STM32');

	const hits = [hit("bmi270.pdf", 34), hit("SPI gotcha", null, "wiki"), hit("bmi270.pdf", 35), hit("bmi270.pdf", 34)];
	assert.equal(searchResult(plain, en, hits, 0, false), '4 hits · bmi270.pdf p.34-35 · note "SPI gotcha"', "pages of one document together, in rank order");
	const many = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"].map((t, i) => hit(t, i + 1));
	assert.equal(searchResult(plain, en, many, 2, false), "5 hits · a.pdf p.1 · b.pdf p.2 · c.pdf p.3 · +2 more · 2 files still importing");
	assert.equal(searchResult(plain, en, [], 0, false), "no matches");
	assert.equal(searchResult(plain, zh, hits, 0, false), "4 条结果 · bmi270.pdf 第 34-35 页 · 笔记「SPI gotcha」");
	const scattered = [148, 145, 132, 150, 149].map((p) => hit("bmi270.pdf", p));
	assert.equal(searchResult(plain, zh, scattered, 0, false), "5 条结果 · bmi270.pdf 第 132、145、148-150 页", "sorted, runs as ranges");

	const open = searchResult(plain, en, [hit("bmi270.pdf", 34, "docs", "The I2C   address is 0x68\nor 0x69")], 0, true).split("\n");
	assert.deepEqual(open.slice(1), ["[bmi270.pdf p.34] The I2C address is 0x68 or 0x69"], "expanded: each hit with its snippet");
});

test("a read shows the document's title and how much came back", () => {
	assert.equal(readCall(plain, en, { id: "k-1", pages: "34-35", view: true }, "bmi270.pdf"), "📚 KB read bmi270.pdf p.34-35 · with page pictures");
	assert.equal(readCall(plain, zh, { id: "k-1" }), "📚 知识库 读取 k-1", "the id when the title is not known");
	const text = "bmi270.pdf (k-1, 162 pages)\nThe text of page 34 was read from an image by OCR.\n\n<!-- kb:page 34 -->\nI2C address 0x68";
	assert.equal(readResult(plain, en, text, { viewed: [34, 35], truncated: true }, false), "16 characters · 🖼 2 pages viewed · more to read");
	assert.deepEqual(readResult(plain, en, text, {}, true).split("\n").slice(1), ["I2C address 0x68"], "expanded: the text, without page markers");
});

test("an import says what happened to the files", () => {
	assert.equal(addResult(plain, en, { added: 2, exists: 1, failed: 0 }), "imported 2 · 1 already there");
	assert.equal(addResult(plain, zh, { added: 0, exists: 0, failed: 0, background: { done: 1, total: 3 } }), "后台导入中 1/3");
	assert.equal(addResult(plain, en, { added: 0, exists: 0, failed: 0, declined: true }), "not imported");
});

test("snippets lose Markdown marks in the terminal", () => {
	assert.equal(plainSnippet("###### Primary Interface By **default**, the device"), "Primary Interface By default, the device");
	assert.equal(plainSnippet("| Address | Name | |---|---|---| | 0x7E | CMD | | |"), "| Address | Name | 0x7E | CMD |");
});

test("a list says what it narrowed to and how much is there", () => {
	assert.equal(listCall(plain, en, {}), "📚 KB list");
	assert.equal(listCall(plain, en, { match: "esp32", scope: "docs", offset: 100 }), '📚 KB list "esp32" · documents only · from #101');
	assert.equal(listResult(plain, en, { docs: 42, notes: 1 }), "42 documents · 1 note");
	assert.equal(listResult(plain, zh, { docs: 0, notes: 3 }), "3 条笔记");
	assert.equal(listResult(plain, en, { docs: 0, notes: 0 }), "nothing listed");
});
