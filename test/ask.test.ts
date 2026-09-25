import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ask, AskError, citedNumbers, listModels, type ModelContext, parseQueries } from "../src/ask.ts";
import { KnowledgeBase } from "../src/kb.ts";

const fixtures = join(import.meta.dirname, "fixtures");
let root: string;
let kb: KnowledgeBase;

before(async () => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	root = mkdtempSync(join(tmpdir(), "pi-kb-ask-"));
	kb = new KnowledgeBase(root);
	await kb.addFile(join(fixtures, "xr100-manual.pdf"));
	await kb.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
});
after(() => {
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

/** A model that answers the planning call and then the answering call with scripted text, recording prompts. */
function fakeModel(plan: string, answer: (prompt: string) => string, calls: { system: string; text: string; model?: string }[] = []): ModelContext {
	const model = { id: "fake", provider: "test", api: "test", maxTokens: 4000 };
	const other = { id: "small/v2", provider: "cheap", name: "Small", api: "test", maxTokens: 4000 };
	const locked = { id: "locked", provider: "test", api: "test", maxTokens: 4000 };
	const all = [model, other, locked];
	const complete = async (used: { id: string }, request: { systemPrompt: string; messages: { content: { text: string }[] }[] }) => {
		const text = request.messages[0].content[0].text;
		calls.push({ system: request.systemPrompt, text, model: used.id });
		const reply = request.systemPrompt.includes("into searches") ? plan : answer(text);
		return { stopReason: "stop", content: [{ type: "text", text: reply }], usage: { input: 10, output: 5 } };
	};
	const modelRegistry = {
		complete,
		getAvailable: () => all,
		find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: { id: string }) => m.id !== "locked",
	};
	return { model, modelRegistry } as unknown as ModelContext;
}

test("parseQueries keeps the question first, drops junk, and survives a bad reply", () => {
	assert.deepEqual(parseQueries('{"queries":["XR-100 电压"," CTRL_REG ",3,""]}', "q"), ["q", "XR-100 电压", "CTRL_REG"]);
	assert.deepEqual(parseQueries("sorry", "q"), ["q"]);
	assert.deepEqual(parseQueries('```json\n{"queries":["a","b","c","d","e"]}\n```', "q"), ["q", "a", "b", "c", "d"]);
});

test("citedNumbers reads [n] and [n, m], in order, only for real passages", () => {
	assert.deepEqual(citedNumbers("3.6 V [2]. Reset 0x00 [1, 2]; see [9] and [2]、[3，1]", 3), [2, 1, 3]);
	assert.deepEqual(citedNumbers("no citations", 3), []);
});

test("ask retrieves passages, answers from them and keeps only the cited sources, renumbered", async () => {
	const calls: { system: string; text: string }[] = [];
	const ctx = fakeModel('{"queries":["CTRL_REG 复位", "SPI 分频"]}', (prompt) => {
		// Cite the passage holding the manual's register page as [2] and one that does not exist.
		const n = [...prompt.matchAll(/^\[(\d+)\] xr100-manual\.pdf p\.2/gm)][0]?.[1];
		return `复位值 0x00 [${n}]，使用 SPI 前写成 0x03 [${n}][42]。`;
	}, calls);
	const r = await ask(kb, ctx, "CTRL_REG 复位后是多少？", new AbortController().signal);
	assert.equal(calls.length, 2, "one planning call, one answering call");
	assert.match(calls[1].text, /CTRL_REG/, "passages go to the model");
	assert.equal(r.answer, "复位值 0x00 [1]，使用 SPI 前写成 0x03 [1]。", "renumbered from 1; invented numbers dropped");
	assert.deepEqual(r.sources.map((s) => [s.n, s.title, s.page]), [[1, "xr100-manual.pdf", 2]]);
	assert.deepEqual(r.queries, ["CTRL_REG 复位", "SPI 分频"], "the searches are reported without the question itself");
	assert.deepEqual(r.usage, { input: 20, output: 10 });
});

test("ask skips the answering call when nothing matches, and needs a model", async () => {
	const calls: { system: string; text: string }[] = [];
	const r = await ask(kb, fakeModel('{"queries":["zebra migration"]}', () => "should not be called", calls), "Where do zebras migrate?", new AbortController().signal);
	assert.equal(calls.length, 1);
	assert.deepEqual([r.answer, r.sources], ["", []]);
	await assert.rejects(ask(kb, undefined, "x", new AbortController().signal), (e: unknown) => e instanceof AskError && e.problem === "no_model");
	const failing = {
		model: { id: "m", maxTokens: 100 },
		modelRegistry: { complete: async () => ({ stopReason: "error", errorMessage: "quota", content: [] }) },
	} as unknown as ModelContext;
	await assert.rejects(ask(kb, failing, "x", new AbortController().signal), (e: unknown) => e instanceof AskError && e.problem === "model_failed" && e.message === "quota");
});

test("the page can pick another model; unknown or unconfigured models are refused", async () => {
	const calls: { system: string; text: string; model?: string }[] = [];
	const ctx = fakeModel('{"queries":["CTRL_REG"]}', () => "0x00 [1]", calls);
	assert.deepEqual(listModels(ctx), {
		current: "test/fake",
		models: [
			{ key: "test/fake", name: "fake", provider: "test" },
			{ key: "cheap/small/v2", name: "Small", provider: "cheap" },
			{ key: "test/locked", name: "locked", provider: "test" },
		],
	});
	assert.deepEqual(listModels(undefined), { models: [] });
	const r = await ask(kb, ctx, "CTRL_REG", new AbortController().signal, "cheap/small/v2");
	assert.deepEqual(calls.map((c) => c.model), ["small/v2", "small/v2"], "ids containing / are split at the first slash");
	assert.equal(r.model, "cheap/small/v2");
	assert.equal((await ask(kb, ctx, "CTRL_REG", new AbortController().signal)).model, "test/fake", "no pick follows pi");
	const refused = (key: string, problem: string) =>
		assert.rejects(ask(kb, ctx, "x", new AbortController().signal, key), (e: unknown) => e instanceof AskError && e.problem === problem);
	await refused("gone/model", "model_missing");
	await refused("nonsense", "model_missing");
	await refused("test/locked", "model_no_auth");
});
