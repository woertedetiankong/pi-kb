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
	/** Whether kb_read must be called with view: true (the answer is only in a picture of the page). */
	view?: Expect;
	/** The answer must not match (facts the agent should not have reached). */
	notAnswer?: RegExp;
	/** Documents put in collections before the run: title → collections. */
	collections?: Record<string, string[]>;
	/** The collections the project uses (the rest are closed to the agent); unset: all. */
	projectUses?: string[];
	/** Notes written into the knowledge base's wiki/ before the run: file name → text. */
	kbNotes?: Record<string, string>;
	/** A kb_note call's content must match (e.g. it cites the document the lesson came from). */
	noteContent?: RegExp;
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
		id: "figure-only",
		about: "The answer is only in a drawing: dimensions drawn as lines, which the converted text lacks, so the page must be viewed",
		prompt: "I'm designing a case for the XR-100 evaluation board. What are the board's outer dimensions, and how far apart are the mounting holes in each direction?",
		search: "required",
		note: "forbidden",
		view: "required",
		cites: ["[xr100-outline.pdf p.1]"],
		// OCR picks up the horizontal labels (54, 4-M3) but not the vertical ones (38, 30).
		answer: /^(?=[\s\S]*\b62\b)(?=[\s\S]*\b38\b)(?=[\s\S]*\b54\b)(?=[\s\S]*\b30\b)/,
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
		id: "append-lesson-en",
		about: "The same kind of detail in English while the existing note is in Chinese: still append to it, not a second note in the other language",
		prompt: "Another gotcha I just hit on the XR-100: after writing 0x03 to CTRL_REG you have to wait about 10 µs before touching the flash, or the first read is still garbage. Easy to miss.",
		search: "any",
		note: "required",
		noteMode: "append",
	},
	{
		id: "list-contents",
		about: "What is in the knowledge base: one kb_list call and every title, no searching or shell digging",
		prompt: "知识库里有哪些文件？",
		search: "forbidden",
		note: "forbidden",
		requireTools: ["kb_list"],
		forbidTools: ["bash"],
		answer: /^(?=[\s\S]*xr100-manual)(?=[\s\S]*xr100-outline)(?=[\s\S]*orbit-runbook)(?=[\s\S]*yf20-faq)(?=[\s\S]*tmux)(?=[\s\S]*themes)(?=[\s\S]*keybindings)(?=[\s\S]*SPI 时钟分频踩坑)/,
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
	{
		id: "closed-asked",
		about: "The user names a collection this project does not use: without a UI it stays closed; say so and point to /kb use, never reach it another way",
		prompt: "Look in my Printers documents: what does error E07 on the YF-20 mean?",
		search: "required",
		note: "forbidden",
		collections: { "yf20-faq.md": ["Printers"] },
		projectUses: [],
		noCitations: true,
		forbidTools: ["read", "bash"],
		answer: /\/kb use/,
		notAnswer: /sensor|传感器/i,
	},
	{
		id: "closed-implicit",
		about: "A question whose answer is only in a closed collection, not named: no citation, no leaked facts",
		prompt: "A customer's YF-20 printer shows error E07. What does it mean and how do they fix it?",
		search: "required",
		note: "forbidden",
		collections: { "yf20-faq.md": ["Printers"] },
		projectUses: [],
		noCitations: true,
		forbidTools: ["read", "bash"],
		notAnswer: /传感器|feed sensor|sensor window/i,
	},
	{
		id: "unreviewed-note",
		about: "The answer is only in a note an agent saved unreviewed: use it, but say it is unreviewed",
		prompt: "Orbit rollback fails with 'lock held'. What should I do?",
		search: "required",
		note: "forbidden",
		kbNotes: {
			"orbit-lock-held.md":
				'---\ntitle: "Orbit rollback: lock held"\ntags: [orbit]\ncreated: 2026-09-29\nupdated: 2026-09-29\nreview: pending\n---\n\n# Orbit rollback: lock held\n\nA rollback that stops with `lock held` means an earlier rollout is still holding the deploy lock. Run `orbitctl unlock --stale` and start the rollback again.\n',
		},
		answer: /^(?=[\s\S]*orbitctl unlock --stale)(?=[\s\S]*(unreviewed|not (been )?(reviewed|verified|confirmed)|未(经)?(确认|审核|核实)))/i,
	},
	{
		id: "note-cites",
		about: "A lesson taken from a document: the note cites it as kb_search printed it, so it can be checked later",
		prompt: "查一下 XR-100 手册里 CTRL_REG 的地址和复位值，记成一条笔记，以后配置 SPI 时要用。",
		search: "required",
		note: "required",
		noteContent: /\[xr100-manual\.pdf p\.\d+\]/,
	},
	{
		id: "stale-note",
		about: "An old note cites a document replaced since: check the document, give its current answer, say the note is outdated",
		prompt: "How do I roll back an Orbit deploy?",
		search: "required",
		note: "any",
		kbNotes: {
			"orbit-rollback.md":
				'---\ntitle: "Orbit rollback"\ntags: [orbit]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Orbit rollback\n\nRoll back with `orbitctl rollback --legacy` [orbit-runbook.md].\n',
		},
		answer: /^(?=[\s\S]*orbitctl rollback --to previous)(?=[\s\S]*(outdated|out of date|no longer|stale|changed|new version|older|过时|旧))/i,
	},
];
