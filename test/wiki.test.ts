import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";
import { Library } from "../src/library.ts";
import { titleSimilarity, wikiLinks } from "../src/notes.ts";
import { initProjectKb } from "../src/project.ts";

let tmp: string;

before(() => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	tmp = mkdtempSync(join(tmpdir(), "pi-kb-wiki-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function twoKnowledgeBases(name: string) {
	const local = join(tmp, `${name}-local`);
	const { project: info } = initProjectKb(join(tmp, name));
	const global = new KnowledgeBase(local);
	const project = new KnowledgeBase(local, { dir: info.dir, project: true });
	const close = () => {
		project.close();
		global.close();
	};
	return { lib: new Library(global, { kb: project, info }), global, project, close };
}

const note = (kb: KnowledgeBase, title: string, content: string, tags: string[] = []) => kb.writeNote(kb.prepareNote({ title, content, tags }));

test("title similarity: the same topic reworded scores high, a shared word does not", () => {
	assert.ok(titleSimilarity("XR100 SPI clock divider", "XR-100 SPI divider") >= 0.7);
	assert.ok(titleSimilarity("SPI 时钟分频踩坑", "SPI 时钟分频的坑") >= 0.7);
	assert.ok(titleSimilarity("Board wiring", "UART wiring") < 0.7);
	assert.ok(titleSimilarity("Docker tips", "Python list sorting") < 0.3);
	assert.equal(titleSimilarity("", "x"), 0);
	assert.deepEqual(wikiLinks("see [[a]], [[hw/board|the board]] and [[a#setup]]"), ["a", "hw/board"]);
});

test("similar notes: alike titles first, then notes a search for the title finds; unrelated ones are left out", async () => {
	const { lib, global, project, close } = twoKnowledgeBases("similar");
	try {
		const divider = note(project, "XR-100 SPI divider", "Write CTRL_REG = 0x03 before touching the flash.");
		const wiring = note(global, "Board wiring", "UART on GPIO43/44; the flash chip select is GPIO10.");
		note(global, "Lunch places", "Noodles on Main Street.");
		const found = await lib.similarNotes("XR100 SPI clock divider");
		assert.deepEqual(found.map((d) => [d.id, d.why, d.scope]), [[divider.id, "title", "project"]], "found across knowledge bases");
		assert.deepEqual((await lib.similarNotes("flash chip select")).map((d) => [d.id, d.why]), [[wiring.id, "search"]]);
		assert.deepEqual(await lib.similarNotes("Python list sorting"), []);
		assert.deepEqual(await lib.similarNotes("XR-100 SPI divider", { exclude: divider.id }), [], "a note is not similar to itself");
	} finally {
		close();
	}
});

test("links resolve by path, file name or title, the linking note's knowledge base first", () => {
	const { lib, global, project, close } = twoKnowledgeBases("links");
	try {
		const mine = note(global, "SPI divider", "global version");
		const team = note(project, "SPI divider", "project version");
		mkdirSync(join(global.wikiDir, "hw"), { recursive: true });
		writeFileSync(join(global.wikiDir, "hw", "board.md"), "# Board wiring\n\nUART on GPIO43.");
		global.sync();
		assert.equal(lib.resolveLink("spi-divider", "global")?.id, mine.id);
		assert.equal(lib.resolveLink("spi-divider", "project")?.id, team.id);
		assert.equal(lib.resolveLink("hw/board")?.title, "Board wiring");
		assert.equal(lib.resolveLink("board.md")?.title, "Board wiring", "a file name with its extension");
		assert.equal(lib.resolveLink("board wiring#UART")?.title, "Board wiring", "a title, ignoring case and the heading");
		assert.equal(lib.resolveLink("nothing here"), undefined);
	} finally {
		close();
	}
});

test("lint finds alike titles, broken links, project notes linking to global ones, and notes without tags", async () => {
	const { lib, global, project, close } = twoKnowledgeBases("lint");
	try {
		const a = note(global, "XR-100 SPI divider", "Set CTRL_REG first. See [[flash-erase]].", ["spi"]);
		const b = note(project, "XR100 SPI clock divider", "Same lesson, found again.", ["spi"]);
		const erase = note(global, "Flash erase", "Erase takes 40 ms per sector.");
		const c = note(project, "Board bring-up", "Follow [[Flash erase]], then [[missing page]].", ["board"]);
		const report = await lib.checkWiki();
		assert.equal(report.notes, 4);
		assert.deepEqual(report.duplicates.map((pair) => pair.map((d) => d.id).sort()), [[a.id, b.id].sort()]);
		assert.deepEqual(report.broken.map((x) => [x.note.id, x.target]), [[c.id, "missing page"]]);
		assert.deepEqual(report.private.map((x) => [x.note.id, x.target.id]), [[c.id, erase.id]], "teammates cannot open a global note");
		assert.deepEqual(report.untagged.map((d) => d.id), [erase.id]);

		// Clean up and check again: nothing left to report.
		lib.remove(b.id);
		lib.remove(c.id);
		global.writeNote(global.prepareNote({ title: "Flash erase", content: "More.", tags: ["flash"] }, "append", erase.id));
		assert.deepEqual(await lib.checkWiki(), { notes: 2, duplicates: [], broken: [], private: [], untagged: [] });
	} finally {
		close();
	}
});

test("tags are read from each note and follow edits", () => {
	const { global, close } = twoKnowledgeBases("tags");
	try {
		const doc = note(global, "Tagged", "Body.", ["SPI", "board"]);
		assert.deepEqual(global.noteTags(doc), ["spi", "board"]);
		const edited = global.editNote(doc.id, global.noteText(doc.id).replace("tags: [spi, board]", "tags: [uart]"));
		assert.deepEqual(global.noteTags(edited), ["uart"]);
	} finally {
		close();
	}
});
