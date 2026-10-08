/**
 * pi-lab's experiment notes through the extension with a fake pi and event bus: mirrored into the knowledge base,
 * found by kb_search, and replaced (not duplicated) when pi-lab rewrites one after a re-run.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-kb-lab-notes-"));
process.env.PI_KB_DIR = join(root, "kb");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_KB_LANG = "en";
const cwd = join(root, "logger-board");
mkdirSync(join(cwd, ".pi", "lab", "notes"), { recursive: true });

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const listeners = new Map<string, ((data: unknown) => void)[]>();
const emitted: { name: string; data: unknown }[] = [];
const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
const fakePi = {
	registerFlag() {},
	getFlag: () => undefined,
	on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
	registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
	registerCommand() {},
	registerMessageRenderer() {},
	getActiveTools: () => [],
	setActiveTools() {},
	sendUserMessage() {},
	events: {
		on: (name: string, fn: (data: unknown) => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
		emit: (name: string, data: unknown) => {
			emitted.push({ name, data });
			for (const fn of listeners.get(name) ?? []) fn(data);
		},
	},
};
const ctx = {
	cwd,
	hasUI: true,
	isIdle: () => true,
	model: undefined,
	ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => true, select: async () => undefined, input: async () => undefined, editor: async () => undefined },
};
const fire = async (name: string, event: unknown = {}) => {
	for (const h of handlers.get(name) ?? []) await h(event, ctx);
};
const search = async (query: string) => (await tools.get("kb_search")!.execute("id", { query }, undefined, undefined, ctx)).content[0].text;

const { default: piKb } = await import("../src/index.ts");
piKb(fakePi as never);
await fire("session_start");
after(async () => {
	await fire("session_shutdown", { reason: "quit" });
	rmSync(root, { recursive: true, force: true });
});

const note = join(cwd, ".pi", "lab", "notes", "dtr-first-restarts-the-board.md");
const write = (status: string) =>
	writeFileSync(note, [
		"---",
		'title: "Lowering DTR first restarts the board"',
		"tags: [pi-lab, experiment, esp32-s3]",
		"status: measured",
		"---",
		"",
		"# Lowering DTR first restarts the board",
		"",
		`**Status:** ${status}`,
		"",
		"| Variant | `rst:0x` | Consistent |",
		"| --- | --- | --- |",
		"| DTR and RTS low before open() | 3/3 | yes |",
		"| pyserial defaults | 0/3 | yes |",
		"",
	].join("\n"));
const announce = () => fakePi.events.emit("pi-lab:notes", { project: "logger-board", root: cwd, files: [note] });
const mirrored = () => readdirSync(join(root, "kb", "wiki", "pi-lab", "logger-board"));

test("pi-lab's notes are mirrored into the knowledge base and found by kb_search", async () => {
	write("measured (E1, 2026-10-07).");
	announce();
	assert.deepEqual(mirrored(), ["dtr-first-restarts-the-board.md"]);
	const reply = emitted.find((e) => e.name === "pi-kb:lab-notes")!.data as { shelf: string };
	assert.equal(reply.shelf, "logger-board lab notes");
	const found = await search("DTR first restart board");
	assert.match(found, /Lowering DTR first restarts the board/);
});

test("a rewritten note replaces its copy instead of adding a second one", async () => {
	write("needs review: a re-run on 2026-10-08 (E4) no longer matches the table.");
	announce();
	announce();
	assert.deepEqual(mirrored(), ["dtr-first-restarts-the-board.md"]);
	const found = await search("needs review re-run no longer matches");
	assert.match(found, /Lowering DTR first restarts the board/);
	// One note (one id), now carrying the status the re-run gave it.
	assert.equal(new Set(found.match(/id=\S+/g)).size, 1);
	assert.match(found, /\*\*Status:\*\* needs review/);
});

test("the experiment block a note carries is not searched", async () => {
	writeFileSync(note, [
		"---", 'title: "Lowering DTR first restarts the board"', "---", "", "# Lowering DTR first restarts the board", "",
		"**Status:** measured (E1, 2026-10-07).", "",
		"```pi-lab-experiment",
		JSON.stringify({ spec: { variants: [{ name: "low", command: "python - <<'PY'\nimport serial\ns = serial.Serial(); s.dtr = False; s.rts = False; s.open()\nPY" }] }, expected: { low: "yes" } }, null, 2),
		"```", "",
	].join("\n"));
	announce();
	assert.doesNotMatch(await search("serial Serial dtr rts open import"), /Lowering DTR first/);
	assert.match(await search("Lowering DTR first restarts"), /Lowering DTR first restarts the board/);
	// The block is still in the note for whoever reads it whole.
	assert.match(readFileSync(join(root, "kb", "wiki", "pi-lab", "logger-board", "dtr-first-restarts-the-board.md"), "utf8"), /```pi-lab-experiment/);
});

test("files that are gone, and malformed announcements, are ignored", () => {
	fakePi.events.emit("pi-lab:notes", { project: "logger-board", root: cwd, files: [join(cwd, "missing.md")] });
	fakePi.events.emit("pi-lab:notes", { project: 3, files: "x" });
	assert.ok(!existsSync(join(root, "kb", "wiki", "pi-lab", "logger-board", "missing.md")));
});
