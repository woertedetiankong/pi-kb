/**
 * Scenarios for checking how a real model uses the knowledge base tools.
 * The corpus is fictional (XR-100 chip, Orbit service, YF-20 printer), so the model cannot answer from memory.
 */

export type Expect = "required" | "forbidden" | "any";

export interface Scenario {
	id: string;
	/** What the scenario checks, shown in the report. */
	about: string;
	prompt: string;
	search: Expect;
	note: Expect;
	/** Whether the kb_note reminder may fire; defaults to forbidden when note is forbidden, else any. */
	nudge?: Expect;
	/** kb_note must use this mode (e.g. append to the existing SPI note). */
	noteMode?: "create" | "append" | "replace";
	/** Citations the answer must contain, exactly as kb_search prints them. */
	cites?: string[];
	/** At least one of these citations must appear (several sources hold the answer). */
	citesAny?: string[];
	/** The answer must contain no citation at all (nothing relevant in the knowledge base). */
	noCitations?: boolean;
	/** The answer must match (the right facts were used). */
	answer?: RegExp;
	/** Files written into the project directory before the run. */
	files?: Record<string, string>;
	/** Files copied into the project directory: name there → path relative to the repository. */
	copy?: Record<string, string>;
	/** Tools that must be called, or must not be, beyond kb_search and kb_note. */
	requireTools?: string[];
	forbidTools?: string[];
}

const addJs = "export function add(a, b) {\n\tconst x = a + b;\n\treturn x;\n}\n";

export const scenarios: Scenario[] = [
	{
		id: "zh-direct",
		about: "Chinese question about a fictional chip in an imported PDF",
		prompt: "XR-100 的最大供电电压是多少？",
		search: "required",
		note: "forbidden",
		cites: ["[xr100-manual.pdf p.1]"],
		answer: /3\.6/,
	},
	{
		id: "en-cross",
		about: "English question, Chinese PDF and Chinese wiki note",
		prompt: "What is the reset value of CTRL_REG on the XR-100, and what should I set it to before using SPI?",
		search: "required",
		note: "forbidden",
		// The manual has the reset value, the SPI note has both.
		citesAny: ["[xr100-manual.pdf p.2]", "[SPI 时钟分频踩坑]"],
		answer: /0x03/,
	},
	{
		id: "implicit-wiki",
		about: "Symptom only, no mention of documents; the answer is an earlier lesson",
		prompt: "板子是 XR-100，外挂的 SPI Flash 读出来的数据总是不对，可能是什么原因？",
		search: "required",
		note: "any",
		cites: ["[SPI 时钟分频踩坑]"],
		answer: /0x03|分频/,
	},
	{
		id: "implicit-runbook",
		about: "Operational question answered by an internal runbook",
		prompt: "Orbit started returning 502s right after I rolled it out from my laptop. What should I check?",
		search: "required",
		note: "any",
		cites: ["[orbit-runbook.md]"],
		answer: /ORBIT_REGION/,
	},
	{
		id: "en-to-zh-faq",
		about: "English customer question, Chinese FAQ",
		prompt: "A customer's YF-20 printer shows error E07. What does it mean and how do they fix it?",
		search: "required",
		note: "forbidden",
		cites: ["[yf20-faq.md]"],
		answer: /sensor|传感器/i,
	},
	{
		id: "missing",
		about: "Not in the knowledge base: must say the documents do not cover it before inferring",
		prompt: "XR-100 支持 USB-C 供电吗？",
		search: "required",
		note: "forbidden",
		answer: /只(说明|写|提到|给出)|(没有|未|没)[^。\n]{0,6}(提到|提及|说明|写明?|记载|找到|看到|查到)|(not|n't) (directly )?(mention|cover|say|state)|no (mention|information)/i,
	},
	{
		id: "general",
		about: "General programming knowledge: searching is optional, citing is wrong",
		prompt: "In JavaScript, what's the simplest way to deep clone a plain object?",
		search: "any",
		note: "forbidden",
		noCitations: true,
	},
	{
		id: "routine-edit",
		about: "Routine code edit: no note",
		prompt: "In add.js, rename the variable x to total.",
		search: "any",
		note: "forbidden",
		files: { "add.js": addJs },
	},
	{
		id: "debug-note",
		about: "Non-obvious bug found by debugging: should save a note at the end",
		prompt: "运行 `node app.js` 报错了，帮我找到原因并修好。",
		search: "any",
		note: "required",
		files: {
			"app.js": 'import { readFileSync } from "node:fs";\n\nconst config = JSON.parse(readFileSync("config.json", "utf8"));\nconsole.log(`listening on ${config.port}`);\n',
			"package.json": '{ "type": "module" }\n',
			// Saved by a Windows editor with a byte order mark.
			"config.json": '﻿{ "port": 8080 }\n',
		},
	},
	{
		id: "trivial-fix",
		about: "A typo breaks a test: the reminder may fire, but a typo is not worth a note",
		prompt: "跑一下 `node --test`，有失败的话修好。",
		search: "any",
		note: "forbidden",
		nudge: "any",
		files: {
			"greet.js": "export function greet(name) {\n\treturn `Helo, ${name}!`;\n}\n",
			"greet.test.js": 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { greet } from "./greet.js";\n\ntest("greets by name", () => {\n\tassert.equal(greet("Ada"), "Hello, Ada!");\n});\n',
			"package.json": '{ "type": "module" }\n',
		},
	},
	{
		id: "save-workspace-pdf",
		about: "Saving a PDF from the project: kb_add keeps it, not a session-only import such as pi-embedded-docs' document_import",
		prompt: "把项目里的 xr200-datasheet.pdf 收进知识库。",
		search: "any",
		note: "forbidden",
		requireTools: ["kb_add"],
		forbidTools: ["document_import"],
		copy: { "xr200-datasheet.pdf": "scripts/model-check/corpus/xr200-datasheet.pdf" },
	},
	{
		id: "workspace-datasheet",
		about: "A question about a datasheet in the project, not in the knowledge base: read it, but do not file it away unasked",
		prompt: "项目里有一份 xr200-datasheet.pdf，这颗芯片的 I2C 地址是多少？",
		search: "any",
		note: "forbidden",
		forbidTools: ["kb_add"],
		answer: /0x2C/i,
		copy: { "xr200-datasheet.pdf": "scripts/model-check/corpus/xr200-datasheet.pdf" },
	},
	{
		id: "setup-fact",
		about: "User mentions a lasting fact about their hardware while asking something else",
		prompt: "顺便说一下，我们产线所有板子上的 Flash 都是 W25Q64JV，3.3V 供电，以后调试 Flash 默认按这个型号来。先帮我确认一下 XR-100 的推荐工作电压和它匹配吗？",
		search: "required",
		note: "required",
		cites: ["[xr100-manual.pdf p.1]"],
	},
	{
		id: "append-lesson",
		about: "New detail for an existing lesson: append to that note instead of a duplicate",
		prompt: "刚又踩到一个坑：XR-100 的 CTRL_REG 写成 0x03 以后，还得等大约 10µs 再访问 Flash，不然第一次读出来还是错的。这个挺隐蔽的。",
		search: "any",
		note: "required",
		noteMode: "append",
	},
	{
		id: "routine-question",
		about: "Short factual lookup: answer and cite, no note",
		prompt: "How do I roll back Orbit?",
		search: "required",
		note: "forbidden",
		cites: ["[orbit-runbook.md]"],
		answer: /orbitctl rollback --to previous/,
	},
];
