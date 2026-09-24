import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";
import { now, parseNote, renderNote, slugify, today } from "../src/notes.ts";

let root: string;
let kb: KnowledgeBase;

before(() => {
	root = mkdtempSync(join(tmpdir(), "pi-kb-notes-"));
	kb = new KnowledgeBase(root);
});
after(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

test("note front matter round-trips, including quotes and Chinese", () => {
	const note = {
		meta: { title: 'SPI "分频" 踩坑', tags: ["spi", "xr100"], created: "2026-09-01", updated: "2026-09-02", project: "fw" },
		body: "根因：复位值为 0x00。",
	};
	const text = renderNote(note);
	assert.match(text, /^---\ntitle: "SPI \\"分频\\" 踩坑"\ntags: \[spi, xr100\]/);
	assert.match(text, /\n# SPI "分频" 踩坑\n\n根因/);
	const parsed = parseNote(text, "fallback");
	assert.deepEqual(parsed.meta, note.meta);
	assert.equal(parseNote("# 手写笔记\n\n内容", "file").meta.title, "手写笔记");
	assert.equal(parseNote(text.replace(/\n/g, "\r\n"), "").body, parseNote(text, "").body);
});

test("dates use local time", () => {
	const date = new Date(2026, 0, 2, 3, 4);
	assert.equal(today(date), "2026-01-02");
	assert.equal(now(date), "2026-01-02 03:04");
});

test("slugify keeps Chinese and drops punctuation", () => {
	assert.equal(slugify("XR-100: SPI 需要先设置分频!"), "xr-100-spi-需要先设置分频");
	assert.match(slugify("!!!"), /^note-\d{4}-\d{2}-\d{2}$/);
});

test("create writes, indexes and logs a note; duplicate titles are refused", () => {
	const prepared = kb.prepareNote({ title: "Flash 读错排查", content: "症状：读回全 0xFF。\n根因：SPI 时钟太快。", tags: ["SPI", "flash"], project: "fw" });
	const doc = kb.writeNote(prepared);
	assert.equal(doc.collection, "wiki");
	assert.equal(doc.title, "Flash 读错排查");
	assert.equal(kb.search("读回全", { collection: "wiki" })[0]?.docId, doc.id);
	assert.match(readFileSync(join(root, "wiki", "log.md"), "utf8"), /created \[\[flash-读错排查\]\] Flash 读错排查/);
	assert.throws(() => kb.prepareNote({ title: "flash 读错排查", content: "x" }), /already exists .*append/);
	// log.md is history, not knowledge.
	assert.equal(kb.syncWiki().removed, 0);
	assert.equal(kb.search("created").length, 0);
});

test("append adds a dated section and merges tags; replace keeps created date", () => {
	const [hit] = kb.search("读回全", { collection: "wiki" });
	const appended = kb.writeNote(kb.prepareNote({ title: "", content: "DMA 模式同样适用。", tags: ["dma", "spi"] }, "append", hit.docId));
	assert.equal(appended.id, hit.docId);
	const text = readFileSync(join(root, appended.path), "utf8");
	assert.match(text, /tags: \[spi, flash, dma\]/);
	assert.match(text, /根因：SPI 时钟太快。\n\n## \d{4}-\d{2}-\d{2}\n\nDMA 模式同样适用。/);

	kb.writeNote(kb.prepareNote({ title: "Flash 读错（已确认）", content: "只保留结论。" }, "replace", hit.docId));
	const replaced = parseNote(readFileSync(join(root, appended.path), "utf8"), "");
	assert.equal(replaced.meta.title, "Flash 读错（已确认）");
	assert.equal(replaced.meta.created, parseNote(text, "").meta.created);
	assert.doesNotMatch(replaced.body, /DMA/);
	assert.throws(() => kb.prepareNote({ title: "x", content: "y" }, "append"), /needs the id/);
});

test("user edits in the editor win over the prepared note", () => {
	const prepared = kb.prepareNote({ title: "烧录经验", content: "先擦除。", tags: ["flash"] });
	const doc = kb.writeNote(prepared, "---\ntitle: 烧录前先擦除扇区\ntags: [flash, burn]\n---\n\n擦除后再写入，否则校验失败。");
	assert.equal(doc.title, "烧录前先擦除扇区");
	const saved = readFileSync(join(root, doc.path), "utf8");
	assert.match(saved, /tags: \[flash, burn\]/);
	assert.match(saved, /created: \d{4}/);
	assert.match(saved, /否则校验失败/);
});

test("hand-written notes without front matter can be appended to", () => {
	writeFileSync(join(root, "wiki", "manual.md"), "# 手写经验\n\n老内容。\n");
	kb.syncWiki();
	const [hit] = kb.search("老内容");
	kb.writeNote(kb.prepareNote({ title: "", content: "新内容。" }, "append", hit.docId));
	const note = parseNote(readFileSync(join(root, "wiki", "manual.md"), "utf8"), "");
	assert.equal(note.meta.title, "手写经验");
	assert.match(note.body, /老内容。[\s\S]*新内容。/);
});
