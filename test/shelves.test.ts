/**
 * Collections ("shelves") of the global knowledge base: what a project sees, how they are kept
 * (document manifests, note front matter) and rebuilt, and how they follow documents around.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { folderShelves } from "../src/index.ts";
import { KnowledgeBase } from "../src/kb.ts";
import { Library } from "../src/library.ts";
import { normalizeShelves, parseNote, renderNote, withShelves } from "../src/notes.ts";
import { VectorIndex } from "../src/semantic/vectors.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `pi-kb-${name}-`));
const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A knowledge base with ESP32 and STM32 documents, a general document and a preference note. */
async function setUp() {
	const root = temp("shelves");
	roots.push(root);
	const files = join(root, "files");
	mkdirSync(files);
	const write = (name: string, text: string) => {
		writeFileSync(join(files, name), text);
		return join(files, name);
	};
	const kb = new KnowledgeBase(join(root, "local"), { dir: join(root, "kb") });
	const esp = await kb.addFile(write("esp32-c3.md", "# ESP32-C3\n\nThe GPIO maximum current is 40 mA."), { shelves: ["ESP32"] });
	const stm = await kb.addFile(write("stm32f1.md", "# STM32F103\n\nThe GPIO maximum current is 25 mA."), { shelves: ["STM32"] });
	const both = await kb.addFile(write("spi-guide.md", "# SPI guide\n\nSet the GPIO clock divider before the first transfer."), { shelves: ["ESP32", "STM32"] });
	const general = await kb.addFile(write("git.md", "# Git tips\n\nGPIO has nothing to do with git; rebase often."));
	const pref = kb.writeNote(kb.prepareNote({ title: "回答用中文", content: "Answer in Chinese, GPIO names in English." }));
	// Written "esp32": the existing collection's spelling is used.
	const lesson = kb.writeNote(kb.prepareNote({ title: "ESP32 GPIO lesson", content: "GPIO 9 is a strapping pin.", shelves: ["esp32"] }));
	return { root, kb, ids: { esp: esp.doc!.id, stm: stm.doc!.id, both: both.doc!.id, general: general.doc!.id, pref: pref.id, lesson: lesson.id } };
}

test("shelf names are tidied; a note's shelves line is set or removed without touching the rest", () => {
	assert.deepEqual(normalizeShelves([" ESP32 ", "esp32", "公司  规范", "[x], y", "-", ""]), ["ESP32", "公司 规范", "x y"]);
	const note = "---\ntitle: \"A\"\ntags: [spi]\ncustom: kept\n---\n\n# A\n\nbody\n";
	const on = withShelves(note, ["ESP32", "STM32"]);
	assert.match(on, /custom: kept\nshelves: \[ESP32, STM32\]\n---\n\n# A\n\nbody/);
	assert.deepEqual(parseNote(on, "x").meta.shelves, ["ESP32", "STM32"]);
	assert.equal(withShelves(on, []), note, "removed again: back to the original");
	assert.equal(withShelves("# Hand-written\n\ntext", ["ESP32"]), "---\nshelves: [ESP32]\n---\n\n# Hand-written\n\ntext");
	assert.equal(parseNote("---\ntitle: x\n---\nbody", "x").meta.shelves, undefined, "no shelves: no field");
	assert.match(renderNote({ meta: { title: "T", tags: [], created: "d", updated: "d", shelves: ["ESP32"] }, body: "b" }), /shelves: \[ESP32\]/);
});

test("a project sees what is in no collection plus its own collections; one collection can be asked for", async () => {
	const { kb, ids } = await setUp();
	const found = (lib: Library, options: { shelf?: string } = {}) =>
		lib.search("GPIO", { limit: 20, ...options }).then((hits) => new Set(hits.map((h) => h.docId)));
	const all = await found(new Library(kb));
	assert.deepEqual(all, new Set(Object.values(ids)), "no choice: everything, as before collections");

	const esp = await found(new Library(kb, undefined, ["ESP32"]));
	assert.deepEqual(esp, new Set([ids.esp, ids.both, ids.general, ids.pref, ids.lesson]), "ESP32 plus everything in none; not STM32");
	assert.deepEqual(await found(new Library(kb, undefined, [])), new Set([ids.general, ids.pref]), "none chosen: only what is in no collection");
	assert.deepEqual(await found(new Library(kb, undefined, ["ESP32"]), { shelf: "STM32" }), new Set([ids.stm, ids.both]), "asked for STM32: only STM32, even here");

	const catalog = new Library(kb, undefined, ["ESP32"]).catalog();
	assert.match(catalog, /^3 document\(s\); 2 wiki note\(s\)\.\n1 more on shelves this project does not use/);
	assert.doesNotMatch(catalog, /stm32f1/);
	assert.deepEqual(new Library(kb, undefined, ["ESP32"]).shelfList(), [
		{ name: "ESP32", docs: 2, notes: 1, used: true },
		{ name: "STM32", docs: 2, notes: 0, used: false },
	]);
});

test("collections are kept with the documents and notes, so a new index (another computer) rebuilds them", async () => {
	const { root, kb, ids } = await setUp();
	const manifest = JSON.parse(readFileSync(join(root, "kb", "docs", `${ids.both}.json`), "utf8"));
	assert.deepEqual(manifest.shelves, ["ESP32", "STM32"]);
	assert.match(kb.noteText(ids.lesson), /shelves: \[ESP32\]/, "a note keeps them in its front matter, spelled as the collection is");

	const lib = new Library(kb);
	lib.setShelves(ids.general, ["Tools"]);
	// A hand-edited note that spells it differently is still in the same collection.
	writeFileSync(join(root, "kb", kb.store.getDoc(ids.lesson)!.path), withShelves(kb.noteText(ids.lesson), ["esp32"]));
	kb.sync();
	assert.equal(new Library(kb).shelfList().length, 3, "ESP32, STM32, Tools: esp32 is ESP32");
	lib.setShelves(ids.pref, ["esp32"]);
	assert.deepEqual(kb.store.shelvesOf(ids.pref), ["ESP32"], "an existing collection's spelling wins");
	lib.setShelves(ids.pref, []);
	assert.doesNotMatch(kb.noteText(ids.pref), /shelves:/);

	const elsewhere = new KnowledgeBase(join(root, "other-computer"), { dir: join(root, "kb") });
	elsewhere.sync();
	assert.deepEqual(Object.fromEntries(elsewhere.store.shelfMap()), Object.fromEntries(kb.store.shelfMap()));
	elsewhere.close();
});

test("collections follow a document: new version, reread, conversion, moving into a project; removing and renaming", async () => {
	const { root, kb, ids } = await setUp();
	const lib = new Library(kb);
	// A new version of the ESP32 document stays in ESP32.
	writeFileSync(join(root, "files", "esp32-c3.md"), "# ESP32-C3\n\nThe GPIO maximum current is 28 mA.");
	const v2 = await kb.addFile(join(root, "files", "esp32-c3.md"), { replace: true });
	assert.deepEqual(kb.store.shelvesOf(v2.doc!.id), ["ESP32"]);
	assert.deepEqual((await kb.reread(v2.doc!.id)).status, "updated");
	assert.deepEqual(kb.store.shelvesOf(v2.doc!.id), ["ESP32"], "reread keeps them");
	const note = await kb.convert(v2.doc!.id);
	assert.deepEqual(kb.store.shelvesOf(note.doc!.id), ["ESP32"], "a document turned note keeps them");
	assert.match(kb.noteText(note.doc!.id), /shelves: \[ESP32\]/);

	assert.equal(lib.renameShelf("stm32", "STM"), 2);
	assert.deepEqual(kb.store.shelvesOf(ids.both), ["ESP32", "STM"]);
	assert.equal(lib.renameShelf("STM"), 2, "removing a collection");
	assert.deepEqual(kb.store.shelvesOf(ids.stm), [], "its documents stay, in none");
	assert.equal(lib.renameShelf("nothing"), 0);

	kb.remove(ids.both);
	assert.deepEqual(kb.store.shelvesOf(ids.both), [], "removed documents leave no collection behind");

	// Into a project: the project is its own shelf.
	const project = new KnowledgeBase(join(root, "local"), { dir: join(root, "project-kb"), project: true });
	const withProject = new Library(kb, { kb: project, info: { root, dir: join(root, "project-kb"), name: "fw" } });
	const moved = withProject.move(ids.general, "project");
	assert.deepEqual(project.store.shelvesOf(moved.id), []);
	assert.equal(JSON.parse(readFileSync(join(root, "project-kb", "docs", `${moved.id}.json`), "utf8")).shelves, undefined);
	assert.throws(() => withProject.setShelves(moved.id, ["ESP32"]), /project's own/);
	project.close();
});

test("importing a folder suggests collections by subfolder; files directly in it get none", () => {
	const root = temp("folders");
	roots.push(root);
	const files = [join(root, "资料", "ESP32", "c3.pdf"), join(root, "资料", "ESP32", "sub", "s3.pdf"), join(root, "资料", "STM32", "f1.pdf"), join(root, "资料", "loose.pdf")];
	for (const f of files) {
		mkdirSync(join(f, ".."), { recursive: true });
		writeFileSync(f, "x");
	}
	const byFile = folderShelves(["资料"], root, files);
	assert.deepEqual([...byFile.values()], ["ESP32", "ESP32", "STM32"]);
	assert.equal(byFile.has(files[3]), false);
	assert.equal(folderShelves([join(root, "资料", "ESP32", "c3.pdf")], root, files).size, 0, "a file named directly: no suggestion");
});

test("semantic search sees only the documents the collections let through", async () => {
	const { kb, ids } = await setUp();
	const vectors = new VectorIndex(kb.store.db);
	// Fake embeddings: every chunk the same direction, so only the filter decides.
	const pending = vectors.pending("fake", 100);
	vectors.put("fake", pending.map((p) => ({ ...p, vector: new Float32Array([1, 0]) })));
	const docsOf = (allow?: Set<string>) =>
		new Set([...kb.store.chunks(vectors.search("fake", new Float32Array([1, 0]), 50, undefined, allow).map((h) => h.rowid)).values()].map((c) => c.docId));
	assert.equal(docsOf().size, 6);
	assert.deepEqual(docsOf(kb.store.visibleIds({ only: "STM32" })), new Set([ids.stm, ids.both]));
	assert.deepEqual(docsOf(kb.store.visibleIds({ any: [] })), new Set([ids.general, ids.pref]));
});
