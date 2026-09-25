import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KnowledgeBase } from "../src/kb.ts";
import { Library } from "../src/library.ts";
import { findProjectKb, initProjectKb, projectRootFor } from "../src/project.ts";

const fixtures = join(import.meta.dirname, "fixtures");
let tmp: string;

before(() => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	tmp = mkdtempSync(join(tmpdir(), "pi-kb-project-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("a project knowledge base is found from any subfolder, created at the git root, and never mistaken for the global one", () => {
	const repo = join(tmp, "xr100-firmware");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "src", "drivers"), { recursive: true });
	assert.equal(findProjectKb(join(repo, "src")), undefined);
	assert.equal(projectRootFor(join(repo, "src", "drivers")), repo);

	const { project, created } = initProjectKb(repo);
	assert.equal(created, true);
	assert.equal(project.name, "xr100-firmware");
	assert.equal(project.dir, join(repo, ".pi", "kb"));
	assert.deepEqual(findProjectKb(join(repo, "src", "drivers")), project);
	const ignore = readFileSync(join(project.dir, ".gitignore"), "utf8");
	assert.match(ignore, /^raw\/$/m, "originals stay out of git");
	assert.match(ignore, /^wiki\/log\.md$/m, "the change log would conflict on every merge");
	assert.ok(existsSync(join(project.dir, "README.md")), "teammates without pi-kb learn what the folder is");
	assert.equal(initProjectKb(repo).created, false, "running it again changes nothing");

	// ~/.pi/kb is the global knowledge base, not a project of the home folder.
	const home = join(tmp, "home");
	mkdirSync(join(home, ".pi", "kb"), { recursive: true });
	assert.equal(findProjectKb(join(home, "notes"), [join(home, ".pi", "kb")]), undefined);
	assert.ok(findProjectKb(join(home, "notes")), "(only because it is excluded)");
});

async function twoKnowledgeBases(name: string) {
	const local = join(tmp, `${name}-local`);
	const repo = join(tmp, name);
	const { project: info } = initProjectKb(repo);
	const global = new KnowledgeBase(local);
	const project = new KnowledgeBase(local, { dir: info.dir });
	return { lib: new Library(global, { kb: project, info }), global, project, info };
}

test("searches cover both and say where each hit comes from; ids are found in either", async () => {
	const { lib, global, project } = await twoKnowledgeBases("search");
	try {
		const manual = await project.addFile(join(fixtures, "xr100-manual.pdf"));
		const lesson = await global.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
		const hits = await lib.find("CTRL_REG");
		assert.deepEqual(new Set(hits.map((h) => h.scope)), new Set(["project", "global"]));
		assert.equal(hits.find((h) => h.docId === manual.doc!.id)?.scope, "project");
		assert.equal(lib.read(lesson.doc!.id).scope, "global");
		assert.equal(lib.read(manual.doc!.id, "2").scope, "project");
		assert.equal(lib.defaultScope, "project", "new material goes to the project unless said otherwise");
		assert.deepEqual(lib.stats(), { docs: 1, wiki: 1, pages: 2, project: { docs: 1, wiki: 0, pages: 2 } });
		assert.deepEqual(lib.listDocs().map((d) => d.scope).sort(), ["global", "project"]);
		const texts = lib.chunkTexts(hits);
		assert.ok(hits.every((h) => texts.get(h)), "chunk numbers are looked up in the right knowledge base");
		assert.match(lib.catalog(), /Project knowledge base "search"[\s\S]*Global \(personal\) knowledge base/);
		assert.equal(new Library(global).defaultScope, "global");
	} finally {
		project.close();
		global.close();
	}
});

test("moving a note or document between the project and the global knowledge base", async () => {
	const { lib, global, project, info } = await twoKnowledgeBases("move");
	try {
		const note = global.writeNote(global.prepareNote({ title: "XR-100 烧录步骤", content: "先按住 BOOT 键。" }));
		const moved = lib.move(note.id, "project");
		assert.equal(moved.scope, "project");
		assert.equal(global.store.listDocs("wiki").length, 0);
		assert.match(project.noteText(moved.id), /先按住 BOOT 键/);

		const pdf = await global.addFile(join(fixtures, "xr100-manual.pdf"));
		const doc = lib.move(pdf.doc!.id, "project");
		assert.equal(doc.title, "xr100-manual.pdf");
		assert.ok(existsSync(join(info.dir, "docs", `${doc.id}.json`)), "described in the project folder, ready to commit");
		assert.equal(global.store.getDoc(pdf.doc!.id), undefined);
		assert.equal((await lib.find("CTRL_REG")).find((h) => h.docId === doc.id)?.scope, "project");
	} finally {
		project.close();
		global.close();
	}
});

test("a teammate's commit arrives through git: the originals are not there, and search, reading and moving still work", async () => {
	// Alice imports into the project; the repository is copied without raw/ (what git would carry).
	const alice = await twoKnowledgeBases("alice");
	const pdf = await alice.project.addFile(join(fixtures, "xr100-manual.pdf"));
	alice.project.writeNote(alice.project.prepareNote({ title: "板子接线", content: "UART 接 GPIO43/44。" }));
	alice.project.close();
	alice.global.close();
	const bobRepo = join(tmp, "bob");
	mkdirSync(join(bobRepo, ".pi", "kb"), { recursive: true });
	for (const part of ["converted", "docs", "wiki", ".gitignore"]) {
		const from = join(alice.info.dir, part);
		if (existsSync(from)) (await import("node:fs")).cpSync(from, join(bobRepo, ".pi", "kb", part), { recursive: true });
	}
	rmSync(join(bobRepo, ".pi", "kb", "wiki", "log.md"), { force: true });

	const info = findProjectKb(bobRepo)!;
	const bobGlobal = new KnowledgeBase(join(tmp, "bob-local"));
	const bobProject = new KnowledgeBase(join(tmp, "bob-local"), { dir: info.dir });
	try {
		assert.deepEqual(bobProject.sync(), { updated: 2, removed: 0 }, "the document and the note");
		const lib = new Library(bobGlobal, { kb: bobProject, info });
		assert.equal((await lib.find("CTRL_REG"))[0]?.scope, "project");
		assert.equal((await lib.find("GPIO43"))[0]?.title, "板子接线");
		assert.equal(lib.read(pdf.doc!.id, "2").doc.pages, 2);
		assert.throws(() => lib.originalFile(pdf.doc!.id), "the original was not committed");
		const copy = lib.move(pdf.doc!.id, "global");
		assert.equal(copy.scope, "global", "moving works without the original too");
		writeFileSync(join(info.dir, "wiki", "extra.md"), "# 新同事的笔记\n\n复位键在背面。");
		assert.deepEqual(lib.sync(), { updated: 1, removed: 0 }, "the next pull is picked up by a sync");
	} finally {
		bobProject.close();
		bobGlobal.close();
	}
});
