/**
 * First-run hints, through the extension itself with a fake pi: the welcome on an empty knowledge
 * base, the empty hint in /kb status, the one-time semantic search tip, /kb help and completions,
 * and naming what to remove by title.
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
let kb!: {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions: (prefix: string) => { value: string }[] | null;
};

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
/** How the fake user answers a select dialog; records what it was asked. */
let asked: { title: string; options: string[] }[] = [];
let answer: (options: string[]) => string | undefined = () => undefined;
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
		select: async (title: string, options: string[]) => {
			asked.push({ title, options });
			return answer(options);
		},
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

test("/kb help lists every command, everyday ones first; completion offers only those until a letter is typed", async () => {
	const values = (prefix: string) => kb.getArgumentCompletions(prefix)?.map((c) => c.value);
	assert.deepEqual(values(""), ["add", "search", "web", "note", "list", "remove", "cancel", "status", "on", "off", "help"]);
	assert.deepEqual(values("ev"), ["eval"], "the others once their first letters are typed");
	assert.deepEqual(values("s"), ["search", "status", "semantic", "sync"]);

	await kb.handler("help", ctx);
	const text = widget.join("\n");
	assert.match(text, /^📚 Knowledge base commands\nEveryday\n {2}\/kb add +Import/);
	assert.ok(text.indexOf("/kb eval") > text.indexOf("More:"), "eval is under More");
	assert.match(widget.find((l) => l.includes("/kb sync")) ?? "", /^ {2}\/kb sync {6}Re-read/, "both groups line up");

	await kb.handler("status", ctx);
	assert.match(notes.at(-1) ?? "", /\nAll commands: \/kb help$/);
	await kb.handler("frobnicate", ctx);
	assert.match(notes.at(-1) ?? "", /Try: add, search, web, .*\(all commands: \/kb help\)/);
});

test("/kb remove takes a title or words from it, and asks which one when several match", async () => {
	asked = [];
	answer = (options) => options.find((o) => o.includes("a.md"));
	await kb.handler("remove md", ctx);
	assert.equal(asked.length, 1);
	assert.equal(asked[0].title, "Remove which one?");
	assert.equal(asked[0].options.length, 2);
	assert.equal(notes.at(-1), "Removed a.md");

	await kb.handler("remove b.md", ctx);
	assert.equal(asked.length, 1, "one match: no question");
	assert.equal(notes.at(-1), "Removed b.md");
	await kb.handler("remove b.md", ctx);
	assert.equal(notes.at(-1), 'Nothing in the knowledge base matches "b.md"');
});
