/** Part numbers the knowledge base never mentions: found, and said, so other parts' values are not taken for them. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";
import { Library } from "../src/library.ts";
import { messages } from "../src/i18n.ts";
import { searchResult, type Style } from "../src/render.ts";
import { partNumbers, partSpellings } from "../src/search.ts";

let root: string;
let kb: KnowledgeBase;
before(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-kb-parts-"));
	kb = new KnowledgeBase(join(root, "kb"));
	const file = join(root, "nx-296.md");
	writeFileSync(file, "# NX-296 datasheet\n\nMaximum supply voltage 4.3 V. Replaces the ESP32-C3 in older boards.\n");
	await kb.addFile(file);
});
after(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

test("part numbers: a letter first, two letters and a digit, four characters or more", () => {
	assert.deepEqual(partNumbers("NX-999 的最大供电电压和 ESP32-P4、STM32F103 比"), ["NX-999", "ESP32-P4", "STM32F103"]);
	assert.deepEqual(partNumbers("What is I2C, 3.3V, 0x41 or p12?"), [], "not buses, values, registers or pages");
	assert.deepEqual(partNumbers("BMI270 BMI270 gpio"), ["BMI270"]);
	assert.deepEqual(partSpellings("ESP32C3").sort(), ["ESP 32C3", "ESP-32C3", "ESP32 C3", "ESP32-C3", "ESP32C 3", "ESP32C-3", "ESP32C3"].sort());
});

test("only parts nothing mentions are reported, whatever the spelling or case", () => {
	const lib = new Library(kb);
	assert.deepEqual(lib.unmentioned("NX-296 最大电压"), []);
	assert.deepEqual(lib.unmentioned("nx296 voltage"), [], "without the hyphen, lower case");
	assert.deepEqual(lib.unmentioned("esp32c3 GPIO"), [], "hyphen missing in the question");
	assert.deepEqual(lib.unmentioned("NX-999 和 NX-296 比较"), ["NX-999"]);
});

test("the terminal row says it first", () => {
	const plain: Style = { fg: (_c, text) => text, bold: (text) => text };
	assert.equal(searchResult(plain, messages("en"), [{ title: "nx-296.md", page: null, collection: "docs" }], 0, false, ["NX-999"]), "nothing mentions NX-999 · 1 hit · nx-296.md");
	assert.equal(searchResult(plain, messages("zh"), [], 0, false, ["NX-999"]), "没有资料提到 NX-999");
});
