import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { copyContent, expandDir, LocationError } from "../src/config.ts";
import { indexFile, KnowledgeBase } from "../src/kb.ts";

const fixtures = join(import.meta.dirname, "fixtures");
let tmp: string;

before(() => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	tmp = mkdtempSync(join(tmpdir(), "pi-kb-location-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const manifest = (root: string, id: string) => JSON.parse(readFileSync(join(root, "docs", `${id}.json`), "utf8"));

test("each document gets a description file in docs/, kept in step with imports, titles and removals", async () => {
	const root = join(tmp, "a");
	const kb = new KnowledgeBase(root);
	try {
		const pdf = await kb.addFile(join(fixtures, "xr100-manual.pdf"));
		const id = pdf.doc!.id;
		assert.deepEqual(manifest(root, id), { ...pdf.doc, path: `converted/${id}.md` }, "everything the index knows, with / in paths");
		// A second README.md elsewhere retitles the first one: its description follows.
		mkdirSync(join(tmp, "p1"), { recursive: true });
		mkdirSync(join(tmp, "p2"), { recursive: true });
		writeFileSync(join(tmp, "p1", "README.md"), "# one\n\nalpha");
		writeFileSync(join(tmp, "p2", "README.md"), "# two\n\nbeta");
		const one = await kb.addFile(join(tmp, "p1", "README.md"));
		await kb.addFile(join(tmp, "p2", "README.md"));
		assert.equal(manifest(root, one.doc!.id).title, "p1/README.md");
		kb.remove(id);
		assert.equal(existsSync(join(root, "docs", `${id}.json`)), false);
	} finally {
		kb.close();
	}
});

test("the index is a cache: another computer (or a lost kb.db) rebuilds it from the folder", async () => {
	const content = join(tmp, "shared");
	const first = new KnowledgeBase(join(tmp, "machine1"), { dir: content });
	const pdf = await first.addFile(join(fixtures, "xr100-manual.pdf"));
	await first.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
	const hitsBefore = await first.find("CTRL_REG");
	first.close();
	assert.equal(existsSync(join(content, "kb.db")), false, "no SQLite in the shared folder");

	const second = new KnowledgeBase(join(tmp, "machine2"), { dir: content });
	try {
		assert.deepEqual(second.sync(), { updated: 2, removed: 0 });
		assert.deepEqual({ ...second.store.getDoc(pdf.doc!.id) }, { ...pdf.doc }, "same facts, from docs/");
		const hits = await second.find("CTRL_REG");
		assert.deepEqual(
			hits.map((h) => [h.title, h.page, h.snippet]),
			hitsBefore.map((h) => [h.title, h.page, h.snippet]),
			"the same chunks, pages and ranks as where it was imported",
		);
		assert.equal(second.read(pdf.doc!.id, "2").doc.pages, 2);
		assert.deepEqual(second.sync(), { updated: 0, removed: 0 }, "nothing to do the second time");

		// A teammate removes the document on their computer: its description disappears here too.
		rmSync(join(content, "docs", `${pdf.doc!.id}.json`));
		assert.deepEqual(second.sync(), { updated: 0, removed: 1 });
		assert.equal((await second.find("CTRL_REG")).filter((h) => h.collection === "docs").length, 0);
	} finally {
		second.close();
	}
});

test("a folder synced only halfway is skipped until the rest arrives; broken files are ignored", async () => {
	const content = join(tmp, "half");
	const kb = new KnowledgeBase(join(tmp, "half-local"), { dir: content });
	try {
		mkdirSync(join(content, "docs"), { recursive: true });
		const record = { id: "k-000000000001", title: "late.pdf", collection: "docs", kind: "pdf", source: "late.pdf", path: "converted/k-000000000001.md", pages: 1, chars: 5, hash: "x", added_at: "2026-09-25T00:00:00.000Z" };
		writeFileSync(join(content, "docs", "k-000000000001.json"), JSON.stringify(record));
		writeFileSync(join(content, "docs", "k-000000000002.json"), "{ not json");
		assert.deepEqual(kb.sync(), { updated: 0, removed: 0 }, "the text is not there yet");
		writeFileSync(join(content, "converted", "k-000000000001.md"), "<!-- kb:source late.pdf -->\n\n<!-- kb:page 1 -->\nhello late arrival\n");
		assert.deepEqual(kb.sync(), { updated: 1, removed: 0 });
		assert.equal((await kb.find("late arrival"))[0]?.page, 1);
	} finally {
		kb.close();
	}
});

test("knowledge bases from before docs/ describe their documents on the first sync, and lose nothing", async () => {
	const root = join(tmp, "old");
	const kb = new KnowledgeBase(root);
	const pdf = await kb.addFile(join(fixtures, "xr100-manual.pdf"));
	rmSync(join(root, "docs"), { recursive: true }); // as an older version left it
	kb.sync();
	assert.equal(manifest(root, pdf.doc!.id).title, "xr100-manual.pdf");
	assert.ok(kb.store.getDoc(pdf.doc!.id), "still indexed");
	kb.close();
});

test("where the index lives, choosing folders, and copying content without overwriting", () => {
	assert.equal(indexFile("/l", "/l"), join("/l", "kb.db"), "the default layout is unchanged");
	assert.match(indexFile("/l", "/Users/me/Dropbox/kb"), /[\\/]l[\\/]indexes[\\/][0-9a-f]{12}[\\/]kb\.db$/);
	assert.notEqual(indexFile("/l", "/a"), indexFile("/l", "/b"), "one index per folder");

	assert.equal(expandDir("~/kb"), join(homedir(), "kb"));
	assert.throws(() => expandDir("kb"), (e: unknown) => e instanceof LocationError && e.problem === "location_relative");
	assert.throws(() => expandDir("  "), LocationError);

	const from = join(tmp, "copy-from"), to = join(tmp, "copy-to");
	mkdirSync(join(from, "wiki"), { recursive: true });
	mkdirSync(join(to, "wiki"), { recursive: true });
	writeFileSync(join(from, "wiki", "a.md"), "from");
	writeFileSync(join(from, "wiki", "b.md"), "from");
	writeFileSync(join(to, "wiki", "b.md"), "already there");
	writeFileSync(join(from, "config.json"), "{}");
	copyContent(from, to);
	assert.deepEqual(readdirSync(join(to, "wiki")).sort(), ["a.md", "b.md"]);
	assert.equal(readFileSync(join(to, "wiki", "b.md"), "utf8"), "already there", "another computer's copy wins");
	assert.equal(existsSync(join(to, "config.json")), false, "settings stay on this machine");
});
