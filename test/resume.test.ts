import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimPending, dropBatch, savePending } from "../src/resume.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `pi-kb-${name}-`));

test("stopped imports are saved and claimed once, uploads copied since their temp files go away", () => {
	const local = temp("resume");
	const uploads = temp("upload");
	const upload = join(uploads, "manual.pdf");
	writeFileSync(upload, "%PDF upload");
	savePending(local, [
		{ path: "/docs/a.pdf", wiki: false, scope: "global" },
		{ path: upload, wiki: false, source: "upload:manual.pdf", replace: true, scope: "project", projectDir: "/work/fw/.pi/kb" },
	]);
	rmSync(uploads, { recursive: true }); // what the web page does once the queue lets go of the upload

	const [batch, ...more] = claimPending(local);
	assert.equal(more.length, 0);
	assert.equal(batch.items[0].path, "/docs/a.pdf");
	const copy = batch.items[1];
	assert.notEqual(copy.path, upload);
	assert.equal(readFileSync(copy.path, "utf8"), "%PDF upload");
	assert.deepEqual({ ...copy, path: "" }, { path: "", wiki: false, source: "upload:manual.pdf", replace: true, scope: "project", projectDir: "/work/fw/.pi/kb" });

	assert.deepEqual(claimPending(local), [], "a claimed batch is not handed out again");
	dropBatch(batch);
	assert.deepEqual(readdirSync(join(local, "pending-imports")), []);
	savePending(local, []);
	assert.deepEqual(readdirSync(join(local, "pending-imports")), [], "nothing left: nothing written");
	rmSync(local, { recursive: true });
});

test("a batch still being written is left alone; one claimed by a pi that died is claimed again", () => {
	const local = temp("resume");
	const root = join(local, "pending-imports");
	mkdirSync(join(root, "1-1-a.writing"), { recursive: true });
	writeFileSync(join(root, "1-1-a.writing", "items.json"), "[");

	savePending(local, [{ path: "/docs/b.pdf", wiki: false }]);
	const [saved] = readdirSync(root).filter((n) => !n.endsWith(".writing"));
	// Claimed by a process that has exited since.
	const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
	renameSync(join(root, saved), join(root, `${saved}.claimed-${dead}`));
	// And one claimed by a running process (this test's parent) stays with it.
	savePending(local, [{ path: "/docs/c.pdf", wiki: false }]);
	const [other] = readdirSync(root).filter((n) => !n.endsWith(".writing") && !n.includes(".claimed-"));
	renameSync(join(root, other), join(root, `${other}.claimed-${process.ppid}`));

	const batches = claimPending(local);
	assert.deepEqual(batches.map((b) => b.items.map((i) => i.path)), [["/docs/b.pdf"]]);
	assert.ok(existsSync(join(root, "1-1-a.writing")), "half-written batch untouched");
	assert.ok(existsSync(join(root, `${other}.claimed-${process.ppid}`)));
	rmSync(local, { recursive: true });
});
