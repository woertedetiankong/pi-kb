import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScopedDoc } from "../src/library.ts";
import { formatList } from "../src/list.ts";

const doc = (title: string, extra: Partial<ScopedDoc> = {}): ScopedDoc => ({
	id: `k-${title}`,
	title,
	collection: "docs",
	kind: "pdf",
	source: `/home/me/datasheets/${title}`,
	path: `converted/${title}.md`,
	pages: 12,
	chars: 1000,
	hash: "h",
	added_at: new Date(2026, 8, 28, 9).toISOString(),
	scope: "global",
	...extra,
});
const note = (title: string) => doc(title, { id: `w-${title}`, collection: "wiki", kind: "note", source: `wiki/${title}.md`, pages: null });

test("kb_list gives every document then every note, by title, with what is needed to open them", () => {
	const text = formatList([note("SPI 时钟分频踩坑"), doc("xr200.pdf"), doc("notes.md", { pages: null, shelves: ["ESP32"] }), doc("bmi270.pdf")]);
	assert.equal(
		text,
		[
			"3 document(s) and 1 wiki note(s).",
			"Documents:",
			"- bmi270.pdf · 12 pages · added 2026-09-28 · id=k-bmi270.pdf",
			"- notes.md · added 2026-09-28 · collection ESP32 · id=k-notes.md",
			"- xr200.pdf · 12 pages · added 2026-09-28 · id=k-xr200.pdf",
			"Wiki notes:",
			"- SPI 时钟分频踩坑 · added 2026-09-28 · id=w-SPI 时钟分频踩坑",
		].join("\n"),
	);
	assert.match(formatList([doc("a.pdf", { scope: "project" })], { scoped: true }), /a\.pdf · 12 pages · added 2026-09-28 · project · id=/);
	assert.equal(formatList([]), "0 document(s) and 0 wiki note(s).");
});

test("match narrows by title or folder, ignoring case", () => {
	const docs = [doc("ESP32-C3.pdf"), doc("stm32.pdf", { source: "/x/ESP32 notes/stm32.pdf" }), doc("bmi270.pdf")];
	assert.match(formatList(docs, { match: "esp32" }), /^2 document\(s\) and 0 wiki note\(s\) whose title or file path contains "esp32"\.\nDocuments:\n- ESP32-C3\.pdf.*\n- stm32\.pdf/);
	assert.match(formatList(docs, { match: "nrf" }), /0 document\(s\).*titles and file paths only: kb_search finds documents that mention it/);
});

test("a long list is paged, and opens with where the documents came from", () => {
	const docs = Array.from({ length: 7 }, (_, i) => doc(`d${i}.pdf`, { source: `/x/${i < 5 ? "ESP32" : "sensors"}/d${i}.pdf`, shelves: i < 2 ? ["STM32"] : undefined }));
	const first = formatList(docs, { limit: 3 }).split("\n");
	assert.deepEqual(first.slice(0, 3), ["7 document(s) and 0 wiki note(s). Showing 1-3, documents then notes, by title.", "Collections: STM32 (2)", "Imported from folders: ESP32 (5), sensors (2)"]);
	assert.equal(first.at(-1), "4 more not shown: call kb_list with offset=3, or narrow with match.");
	const last = formatList(docs, { limit: 3, offset: 6 }).split("\n");
	assert.match(last[0], /Showing 7-7/);
	assert.match(last.at(-1)!, /^- d6\.pdf/);
	assert.match(formatList(docs, { offset: 50 }), /offset 50 is past the end/);
});
