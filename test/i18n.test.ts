import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { messages, parseLanguage, resolveLanguage } from "../src/i18n.ts";

const saved = process.env.PI_KB_LANG;
afterEach(() => {
	if (saved === undefined) delete process.env.PI_KB_LANG;
	else process.env.PI_KB_LANG = saved;
});

test("parseLanguage understands locale strings and ignores the C locale", () => {
	assert.equal(parseLanguage("zh_CN.UTF-8"), "zh");
	assert.equal(parseLanguage("zh-Hans-US"), "zh");
	assert.equal(parseLanguage("en_US.UTF-8"), "en");
	assert.equal(parseLanguage("C.UTF-8"), undefined);
	assert.equal(parseLanguage("POSIX"), undefined);
	assert.equal(parseLanguage("fr_FR"), undefined);
});

test("PI_KB_LANG beats the saved setting, which beats the system language", () => {
	delete process.env.PI_KB_LANG;
	assert.equal(resolveLanguage("zh"), "zh");
	assert.equal(resolveLanguage("en"), "en");
	process.env.PI_KB_LANG = "zh";
	assert.equal(resolveLanguage("en"), "zh");
	assert.ok(["en", "zh"].includes(resolveLanguage("auto")));
});

test("both languages cover every subcommand and keep choices aligned", () => {
	const en = messages("en");
	const zh = messages("zh");
	assert.deepEqual(Object.keys(zh.subcommands).sort(), Object.keys(en.subcommands).sort());
	assert.equal(zh.noteChoices.length, en.noteChoices.length);
	assert.equal(zh.statusOn(3, 1), "📚 知识库 · 3 份文档 · 1 条笔记");
	assert.equal(en.statusOn(3, 1), "📚 KB · 3 docs · 1 notes");
});
