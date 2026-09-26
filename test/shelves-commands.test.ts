/**
 * Collections through the extension itself with a fake pi: importing a folder by subfolder,
 * /kb add --to, /kb use, /kb group, kb_search's shelf, kb_note's shelf and the system prompt.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pi-kb-shelf-cmds-"));
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
const asked: { title: string; options: string[] }[] = [];
let answer: (options: string[]) => string | undefined = () => undefined;
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
const until = async (check: () => boolean) => {
	while (!check()) await new Promise((r) => setTimeout(r, 5));
};
const config = () => JSON.parse(readFileSync(join(root, "kb", "config.json"), "utf8"));
const search = async (params: Record<string, unknown>) => (await tools.get("kb_search")!.execute("id", params, undefined, undefined, ctx)).content[0].text;

const { default: piKb } = await import("../src/index.ts");
piKb(fakePi as never);
await fire("session_start");
after(async () => {
	await fire("session_shutdown", { reason: "quit" });
	rmSync(root, { recursive: true, force: true });
});

test("importing a folder asks to group by subfolder; --to names one; /kb use lists and chooses", async () => {
	await kb.handler("use", ctx);
	assert.match(widget.join("\n"), /No collections yet/);

	const lib = join(root, "资料");
	for (const [dir, name, text] of [["ESP32", "c3.md", "ESP32-C3 GPIO current 40 mA"], ["STM32", "f1.md", "STM32F1 GPIO current 25 mA"], ["", "loose.md", "General GPIO current advice"]]) {
		mkdirSync(join(lib, dir), { recursive: true });
		writeFileSync(join(lib, dir, name), `# ${name}\n\n${text}\n`);
	}
	answer = (options) => options[0];
	widget = [];
	await kb.handler(`add ${lib}`, ctx);
	assert.match(asked.at(-1)!.title, /^Put the files in collections by folder\?\n {2}ESP32: 1 file\n {2}STM32: 1 file\n {2}no collection: 1 file/);
	await until(() => /import/i.test(widget[0] ?? ""));

	writeFileSync(join(root, "tools.md"), "# Tools\n\nGPIO test clip wiring");
	widget = [];
	await kb.handler(`add ${join(root, "tools.md")} --to Tools`, ctx);
	await until(() => /import/i.test(widget[0] ?? ""));

	await kb.handler("use", ctx);
	assert.match(widget.join("\n"), /This project uses all collections \(the default\)\.\n\n☑ ESP32 · 1 document · 0 notes\n☑ STM32 · 1 document · 0 notes\n☑ Tools · 1 document · 0 notes/);

	await kb.handler("use esp32 Nope", ctx);
	assert.equal(notes.at(-1), "No collection named Nope; see /kb use");
	await kb.handler("use esp32", ctx);
	assert.equal(notes.at(-1), "This project now uses: ESP32, plus everything in no collection");
	assert.deepEqual(config().projects[cwd], { shelves: ["ESP32"] });
});

test("kb_search covers what the project uses; shelf asks for one collection; the prompt explains", async () => {
	const text = await search({ query: "GPIO current" });
	assert.match(text, /c3\.md/);
	assert.doesNotMatch(text, /f1\.md/, "STM32 is not used here");
	assert.match(text, /loose\.md/, "no collection: seen everywhere");
	assert.match(await search({ query: "GPIO current", shelf: "stm32" }), /f1\.md/);
	assert.match(await search({ query: "GPIO", shelf: "AVR" }), /No collection named "AVR"\. The collections are: ESP32, STM32, Tools\./);

	const sections: Record<string, string> = {};
	await fire("before_agent_start", { systemPromptOptions: { sections } });
	assert.match(sections.knowledge_base, /grouped into collections\. This project uses ESP32, plus everything in no collection.*Other collections: STM32, Tools/);
	assert.match(sections.knowledge_base, /2 more on shelves this project does not use/);
});

test("kb_note puts a lesson in the collection it names, and the user can change it", async () => {
	answer = (options) => options[0];
	const save = await tools.get("kb_note")!.execute("id", { title: "C3 strapping pins", content: "GPIO 9 is a strapping pin.", shelf: "esp32" }, undefined, undefined, ctx);
	assert.match(save.content[0].text, /collection ESP32/);
	assert.match(asked.at(-1)!.title, /collection ESP32$/);

	// Changed to none in the dialog, then saved.
	let step = 0;
	answer = (options) => (step++ === 0 ? options.find((o) => o === "Change the collection") : step === 2 ? options[0] : options[0]);
	const pref = await tools.get("kb_note")!.execute("id", { title: "Answer in Chinese", content: "The user prefers Chinese answers.", shelf: "ESP32" }, undefined, undefined, ctx);
	assert.deepEqual(asked.at(-2)!.options, ["None: every project sees it", "ESP32"], "the project's collections to choose from");
	assert.doesNotMatch(pref.content[0].text, /collection/);
});

test("/kb group puts an item in a collection; renaming follows into the projects' choice", async () => {
	answer = (options) => options[0];
	await kb.handler("group loose STM32", ctx);
	assert.equal(notes.at(-1), "loose.md is now in: STM32");
	await kb.handler("group --rename esp32 Espressif", ctx);
	assert.equal(notes.at(-1), "Renamed collection ESP32 to Espressif (2 items)");
	assert.deepEqual(config().projects[cwd], { shelves: ["Espressif"] });
	await kb.handler("group --delete Tools", ctx);
	assert.equal(notes.at(-1), "Removed collection Tools; its 1 item stay, in no collection");
	await kb.handler("use all", ctx);
	assert.equal(config().projects, undefined);
});
