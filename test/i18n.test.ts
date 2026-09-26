import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	assert.equal(zh.statusOn(3, 1), "📚 知识库 · 3 份资料 · 1 条笔记");
	assert.equal(en.statusOn(3, 1), "📚 KB · 3 docs · 1 note");
	assert.equal(en.statusOn(1, 0), "📚 KB · 1 doc · 0 notes");
});

test("the web page's texts: no key defined twice (the later one silently wins), and both languages have the same keys", async () => {
	const { default: ts } = await import("typescript");
	const html = readFileSync(join(import.meta.dirname, "..", "web", "kb.html"), "utf8");
	const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
	const file = ts.createSourceFile("kb.js", script, ts.ScriptTarget.Latest);
	let table: import("typescript").ObjectLiteralExpression | undefined;
	file.forEachChild(function find(node) {
		// const T = { zh: {…}, en: {…} }[LANG];
		const init = ts.isVariableDeclaration(node) && node.name.getText(file) === "T" ? node.initializer : undefined;
		const object = init && ts.isElementAccessExpression(init) ? init.expression : init;
		if (object && ts.isObjectLiteralExpression(object)) table = object;
		else node.forEachChild(find);
	});
	assert.ok(table, "const T = { zh: {…}, en: {…} }[LANG]");
	const keys: Record<string, string[]> = {};
	for (const lang of table.properties) {
		if (!ts.isPropertyAssignment(lang) || !ts.isObjectLiteralExpression(lang.initializer)) continue;
		keys[lang.name.getText(file)] = lang.initializer.properties.map((p) => p.name?.getText(file) ?? "");
	}
	for (const [lang, names] of Object.entries(keys)) {
		assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], `${lang}: keys defined twice`);
	}
	assert.deepEqual([...keys.zh].sort(), [...keys.en].sort());
});
