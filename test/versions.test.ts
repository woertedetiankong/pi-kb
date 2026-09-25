import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { KnowledgeBase, sourcePath } from "../src/kb.ts";

let root: string;
let src: string;
let kb: KnowledgeBase;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-kb-versions-"));
	src = join(root, "src");
	kb = new KnowledgeBase(join(root, "kb"));
});
afterEach(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

function file(rel: string, text: string): string {
	const path = join(src, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return path;
}

test("sourcePath keeps the last folders of a path, or just an upload's name", () => {
	assert.equal(sourcePath("/a/b/project-3/README.md", 2), "project-3/README.md");
	assert.equal(sourcePath("/a/b/README.md", 1), "README.md");
	assert.equal(sourcePath("upload:manual.pdf", 3), "manual.pdf");
});

test("files with the same name get titles that tell them apart, and stay searchable by folder", async () => {
	const a = await kb.addFile(file("alpha/docs/README.md", "# Alpha\n\nsetup alpha widget"));
	assert.equal(a.doc?.title, "README.md", "a unique name stays as it is");
	const b = await kb.addFile(file("beta/docs/README.md", "# Beta\n\nsetup beta widget"));
	// docs/README.md would still clash, so one more folder is shown, on both.
	assert.equal(b.doc?.title, "beta/docs/README.md");
	assert.equal(kb.store.getDoc(a.doc!.id)?.title, "alpha/docs/README.md");
	assert.deepEqual((await kb.find("alpha widget")).map((h) => h.title), ["alpha/docs/README.md"]);
	assert.ok((await kb.find("beta README")).some((h) => h.title === "beta/docs/README.md"), "the folder name is searchable");
	const c = await kb.addFile(file("gamma/docs/README.md", "# Gamma\n\nsetup gamma widget"));
	assert.equal(c.doc?.title, "gamma/docs/README.md", "a third one shows its folder too, though README.md is free");

	const up = await kb.addFile(file("tmp/README.md", "# Upload\n\nuploaded gamma"), { source: "upload:README.md" });
	assert.equal(up.doc?.title, "README.md", "the plain name is free again");
	const up2 = await kb.addFile(file("tmp2/README.md", "# Upload 2\n\nuploaded delta"), { source: "upload:README.md" });
	assert.equal(up2.doc?.title, "README.md (2)", "uploads have no folder, so they are numbered");
});

test("a changed file is recognised as a new version, and replacing keeps the title and drops the old one", async () => {
	const path = file("manuals/xr100.md", "# XR-100\n\nmax voltage 3.6V");
	const v1 = await kb.addFile(path);
	assert.deepEqual(kb.previousVersions(path), [], "identical content is not a new version");

	writeFileSync(path, "# XR-100\n\nmax voltage 3.3V (rev B)");
	assert.deepEqual(kb.previousVersions(path).map((d) => d.id), [v1.doc!.id]);
	assert.deepEqual(kb.previousVersions(file("other/xr100.md", "x"), undefined), [], "another path is another document");
	assert.deepEqual(kb.previousVersions(path, { name: "xr100.md" }).map((d) => d.id), [v1.doc!.id], "an upload matches by file name");

	const v2 = await kb.addFile(path, { replace: [v1.doc!.id] });
	assert.equal(v2.status, "added");
	assert.deepEqual(v2.replaced, [v1.doc!.id]);
	assert.equal(v2.doc?.title, "xr100.md");
	assert.equal(kb.store.getDoc(v1.doc!.id), undefined);
	assert.equal(existsSync(join(kb.root, "raw", v1.doc!.id)), false);
	assert.deepEqual((await kb.find("voltage")).map((h) => h.snippet.includes("3.3V")), [true]);
});

test("keeping both versions numbers the second one", async () => {
	const path = file("manuals/xr100.md", "# XR-100\n\nrev A");
	await kb.addFile(path);
	writeFileSync(path, "# XR-100\n\nrev B");
	const v2 = await kb.addFile(path);
	assert.equal(v2.doc?.title, "xr100.md (2)");
	assert.equal(kb.store.listDocs("docs").length, 2);
	// Both old versions are offered for replacement next time.
	writeFileSync(path, "# XR-100\n\nrev C");
	assert.equal(kb.previousVersions(path).length, 2);
});
