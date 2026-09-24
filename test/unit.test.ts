import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkPages } from "../src/chunk.ts";
import { normalizeText } from "../src/convert.ts";
import { padDisplay, splitArgs } from "../src/index.ts";
import { coverage, planQuery } from "../src/search.ts";

test("splitArgs handles quotes and drag-and-drop escapes", () => {
	assert.deepEqual(splitArgs('add "My Docs/a b.pdf" ~/x\\ y.md --note'), ["add", "My Docs/a b.pdf", "~/x y.md", "--note"]);
	assert.deepEqual(splitArgs("  "), []);
	assert.deepEqual(splitArgs('search ""'), ["search", ""]);
});

test("normalizeText removes OCR gaps between Chinese characters and Markdown escapes", () => {
	assert.equal(normalizeText("推 荐 工作 电压 3.3V"), "推荐工作电压 3.3V");
	assert.equal(normalizeText("CTRL\\_REG 地 址 0x40"), "CTRL_REG 地址 0x40");
});

test("planQuery routes short terms to LIKE and expands long Chinese runs into trigrams", () => {
	const plan = planQuery("VDD 电压 供电电压范围");
	assert.deepEqual(plan.short, ["电压"]);
	assert.match(plan.match ?? "", /"vdd"/);
	assert.match(plan.match ?? "", /"供电电"/);
	assert.equal(coverage(plan, { title: "", heading: "", content: "VDD 供电电压范围 2.7V", bm25: 0 }), 1);
});

test("chunkPages keeps page numbers and carries headings across pages", () => {
	const chunks = chunkPages([
		{ page: 1, markdown: "# Intro\n\nhello" },
		{ page: 2, markdown: "continued text" },
	]);
	assert.deepEqual(
		chunks.map((c) => [c.page, c.heading, c.content]),
		[
			[1, "Intro", "# Intro\n\nhello"],
			[2, "Intro", "continued text"],
		],
	);
	const long = chunkPages([{ page: 1, markdown: "x".repeat(3000) }], 1200);
	assert.equal(long.length, 3);
});

test("padDisplay aligns Chinese and ASCII labels to the same column", () => {
	assert.equal(padDisplay("PDF", 7), "PDF    ");
	assert.equal(padDisplay("文本", 7), "文本   ");
	assert.equal(padDisplay("toolongname", 4), "toolongname ");
});
