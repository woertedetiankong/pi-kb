/**
 * First-run hints, through the extension itself with a fake pi: the welcome on an empty knowledge
 * base, the empty hint in /kb status, and the one-time semantic search tip.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-kb-onboarding-"));
process.env.PI_KB_DIR = join(root, "kb");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_KB_LANG = "en";
const cwd = join(root, "work");
mkdirSync(cwd, { recursive: true });

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
let kb!: { handler: (args: string, ctx: unknown) => Promise<void> };

const fakePi = {
	registerFlag() {},
	getFlag: () => undefined,
	on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
	registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
	registerCommand: (_name: string, command: typeof kb) => (kb = command),
	registerMessageRenderer() {},
	getActiveTools: () => [],
	setActiveTools() {},
	sendUserMessage() {},
};

const notes: string[] = [];
let widget: string[] = [];
const ctx = {
	cwd,
	hasUI: true,
	isIdle: () => true,
	model: undefined,
	ui: {
		notify: (text: string) => notes.push(text),
		setStatus() {},
		setWidget: (_key: string, lines?: string[]) => (widget = lines ?? []),
		confirm: async () => true,
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
	},
};
const fire = async (name: string, event: unknown = {}) => {
	for (const h of handlers.get(name) ?? []) await h(event, ctx);
};

const { default: piKb } = await import("../src/index.ts");
piKb(fakePi as never);

after(async () => {
	await fire("session_shutdown", { reason: "quit" });
	rmSync(root, { recursive: true, force: true });
});

const welcome = /Knowledge base ready\. Add your documents with \/kb add/;
const tip = /semantic search is off/i;

test("an empty knowledge base says how to start, once", async () => {
	await fire("session_start");
	assert.equal(notes.filter((n) => welcome.test(n)).length, 1);

	await fire("session_shutdown", { reason: "new" });
	await fire("session_start");
	assert.equal(notes.filter((n) => welcome.test(n)).length, 1, "not repeated in the next session");

	await kb.handler("status", ctx);
	assert.match(notes.at(-1) ?? "", /Nothing here yet: add documents with \/kb add/);
});

test("with keyword search only, an empty search says why, for the user and the agent", async () => {
	await kb.handler("search nothing-like-this", ctx);
	assert.match(widget.join("\n"), tip);
	const result = await tools.get("kb_search")!.execute("id", { query: "nothing-like-this" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /Semantic search is off[\s\S]*\/kb semantic/);
});

test("the first import mentions semantic search once, and the empty hint goes away", async () => {
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 5));
	};
	writeFileSync(join(cwd, "a.md"), "# XR-100\n\nSupply voltage 3.3 V.\n");
	writeFileSync(join(cwd, "b.md"), "# YF-20\n\nError E07: paper jam.\n");

	widget = [];
	await kb.handler("add a.md", ctx);
	await until(() => /import/i.test(widget[0] ?? ""));
	assert.match(widget.join("\n"), tip, "after the first import");

	widget = [];
	await kb.handler("add b.md", ctx);
	await until(() => /import/i.test(widget[0] ?? ""));
	assert.doesNotMatch(widget.join("\n"), tip, "only once");

	const saved = JSON.parse(readFileSync(join(root, "kb", "config.json"), "utf8"));
	assert.deepEqual(saved.tips, ["welcome", "semantic"]);
	await kb.handler("status", ctx);
	assert.doesNotMatch(notes.at(-1) ?? "", /Nothing here yet/);
});
