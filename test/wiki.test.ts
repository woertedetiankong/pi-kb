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
		assert.deepEqual(await lib.checkWiki(), { notes: 2, duplicates: [], broken: [], private: [], untagged: [], unreviewed: [], staleSources: [] });
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

test("a note saved with nobody to review it is marked until approved; approving changes nothing else", async () => {
	const { lib, global, close } = twoKnowledgeBases("review");
	try {
		const agent = global.writeNote(global.prepareNote({ title: "Flash needs 3.3 V", content: "Seen on the bench.", tags: ["flash"], unreviewed: true }));
		const user = global.writeNote(global.prepareNote({ title: "Answer in Chinese", content: "Preference." }));
		assert.match(global.noteText(agent.id), /\nreview: pending\n---/);
		assert.equal(lib.unreviewed({ ...agent, scope: "global" }), true);
		assert.equal(lib.unreviewed({ ...user, scope: "global" }), false);

		// An unreviewed append marks the whole note; one the user saved clears it.
		global.writeNote(global.prepareNote({ title: "", content: "More.", unreviewed: true }, "append", user.id));
		assert.equal(global.unreviewed(global.store.getDoc(user.id)!), true);
		global.writeNote(global.prepareNote({ title: "", content: "Checked." }, "append", user.id));
		assert.equal(global.unreviewed(global.store.getDoc(user.id)!), false);

		const report = await lib.checkWiki();
		assert.deepEqual(report.unreviewed.map((d) => d.id), [agent.id]);
		const before = global.noteText(agent.id);
		lib.approveNote(agent.id);
		assert.equal(global.noteText(agent.id), before.replace("review: pending\n", ""));
		assert.equal(lib.unreviewed({ ...agent, scope: "global" }), false);
	} finally {
		close();
	}
});

test("a note citing a document is flagged once the document is replaced by a new version or removed, until checked", async () => {
	const { lib, global, close } = twoKnowledgeBases("sources");
	try {
		const file = join(tmp, "board.md");
		writeFileSync(file, "# Board\n\nVDD is 3.3 V.\n");
		const doc = (await global.addFile(file)).doc!;
		const note = global.writeNote(
			global.prepareNote({ title: "Board supply", content: `The board runs at 3.3 V [${doc.title}].\n\nAlso [gone.pdf p.4] and [a plain remark]; fixed in [main.c] and [config.json p.2].` }),
		);
		// Written a while ago.
		global.editNote(note.id, global.noteText(note.id).replace(/updated: .*/, "updated: 2026-01-01"));
		const at = { id: note.id, title: note.title, scope: "global" as const };
		const sources = lib.noteSources(at);
		assert.deepEqual(sources.map((s) => [s.text, !!s.changed, !!s.missing]), [
			[`[${doc.title}]`, true, false],
			["[gone.pdf p.4]", false, true],
		], "imported after the note's date counts as changed; a plain remark, code and data files are no citations of documents");

		lib.markChecked(note.id);
		assert.deepEqual(lib.noteSources(at).map((s) => !!s.changed), [false, false], "checked today");
		assert.match(global.noteText(note.id), /The board runs at 3\.3 V/, "the text stays");

		// A new version of the document, imported after the note was last checked.
		global.editNote(note.id, global.noteText(note.id).replace(/updated: .*/, "updated: 2026-01-01"));
		writeFileSync(file, "# Board\n\nVDD is 5 V now.\n");
		await global.addFile(file, { replace: true });
		const report = await lib.checkWiki();
		assert.deepEqual(report.staleSources.map((s) => [s.note.id, s.sources.map((x) => x.text)]), [[note.id, [`[${doc.title}]`, "[gone.pdf p.4]"]]]);

		const { formatHits } = await import("../src/tools.ts");
		const { messages } = await import("../src/i18n.ts");
		const hit = { chunk: 1, docId: note.id, title: note.title, collection: "wiki" as const, page: null, heading: "", snippet: "…", score: 0, match: "keyword" as const, staleSources: [`[${doc.title}]`] };
		assert.match(formatHits([hit], messages("en")), /sources changed since this note: \[board\.md\]/);
	} finally {
		close();
	}
});

test("looksLikeDocument: documents yes, code and data no", async () => {
	const { looksLikeDocument } = await import("../src/convert.ts");
	for (const name of ["manual.pdf", "Spec.DOCX", "pins.png", "faq.md", "notes.txt", "page.html", "README.md (2)"]) assert.equal(looksLikeDocument(name), true, name);
	for (const name of ["main.c", "app.ts", "config.json", "setup.py", "a plain remark", "v2.3"]) assert.equal(looksLikeDocument(name), false, name);
});
