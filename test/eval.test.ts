import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_SEMANTIC } from "../src/config.ts";
import { initQuestions, matches, parseQuestions, questionsFile, runEval, summaryRows, TEMPLATE, writeReport } from "../src/eval.ts";
import { messages } from "../src/i18n.ts";
import { displayWidth, textTable } from "../src/index.ts";
import { KnowledgeBase } from "../src/kb.ts";

const fixtures = join(import.meta.dirname, "fixtures");

test("parseQuestions reads answers, pages, alternatives and no-answer lines; reports bad lines", () => {
	const { questions, errors } = parseQuestions(
		[
			"# comment",
			"",
			"芯片最高电压 | xr100-manual.pdf p.1",
			"SPI 分频 | xr100-manual.pdf p2； SPI 时钟分频踩坑",
			"a | b | Manual.PDF",
			"今天午饭吃什么 | -",
			"no answer column",
			"| missing question",
		].join("\n"),
	);
	assert.deepEqual(
		questions.map((q) => [q.line, q.question, q.expected]),
		[
			[3, "芯片最高电压", [{ doc: "xr100-manual.pdf", page: 1 }]],
			[4, "SPI 分频", [{ doc: "xr100-manual.pdf", page: 2 }, { doc: "SPI 时钟分频踩坑" }]],
			[5, "a | b", [{ doc: "Manual.PDF" }]],
			[6, "今天午饭吃什么", []],
		],
	);
	assert.deepEqual(errors, [7, 8]);
	assert.equal(parseQuestions(TEMPLATE).questions.length, 0, "the template's examples are comments");
});

test("matches compares titles case-insensitively, pages exactly, or ids", () => {
	const hit = { title: "XR100-Manual.pdf", docId: "k-1", page: 2 };
	assert.ok(matches(hit, [{ doc: "xr100-manual" }]));
	assert.ok(matches(hit, [{ doc: "xr100", page: 2 }]));
	assert.ok(!matches(hit, [{ doc: "xr100", page: 1 }]));
	assert.ok(matches(hit, [{ doc: "k-1" }]));
	assert.ok(!matches(hit, []));
});

test("textTable lines up Chinese and ASCII columns", () => {
	const lines = textTable([
		["模式", "第一条命中"],
		["keyword", "50%"],
	]);
	assert.equal(displayWidth(lines[0].slice(0, lines[0].indexOf("第"))), displayWidth(lines[1].slice(0, lines[1].indexOf("5"))));
});

/** Concept embeddings: voltage, SPI/clock, flash/erase (as in semantic.test.ts). */
const CONCEPTS = [/电压|伏|voltage|volt/gi, /spi|时钟|clock|分频|divider/gi, /擦除|烧录|erase|flash/gi];
let server: Server;
let baseUrl: string;
before(async () => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const { input } = JSON.parse(body) as { input: string[] };
			const data = input.map((text, index) => ({ index, embedding: [...CONCEPTS.map((re) => (text.match(re) ?? []).length), 0.01] }));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

test("runEval scores each mode, and writes a report", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-eval-"));
	const kb = new KnowledgeBase(root);
	try {
		await kb.addFile(join(fixtures, "xr100-manual.pdf"));
		await kb.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
		assert.ok(initQuestions(root));
		assert.ok(!initQuestions(root), "never overwrites");
		writeFileSync(
			questionsFile(root),
			`${TEMPLATE}CTRL_REG 地址 | xr100-manual.pdf p.2\nmaximum voltage of the chip | xr100-manual.pdf p.1\n今天午饭吃什么 | -\n`,
		);
		const { questions } = parseQuestions(readFileSync(questionsFile(root), "utf8"));

		// Keyword only: finds the register (same words) but not the English voltage question.
		let report = await runEval(kb, questions);
		assert.deepEqual(
			report.modes.map((m) => m.mode),
			["keyword"],
		);
		const keyword = report.modes[0];
		assert.deepEqual([keyword.answerable, keyword.hit1, keyword.hit8, keyword.unanswerable, keyword.quiet], [2, 1, 1, 1, 1]);
		assert.equal(keyword.mrr, 0.5);

		// With semantic search, the cross-language question is found too.
		kb.updateConfig({ semantic: { ...DEFAULT_SEMANTIC, provider: "api", api: { baseUrl, model: "concepts" } } });
		await kb.indexSemantic();
		const done: number[] = [];
		report = await runEval(kb, questions, (d) => done.push(d));
		assert.deepEqual(done, [1, 2, 3]);
		assert.deepEqual(
			report.modes.map((m) => [m.mode, m.hit8]),
			[
				["keyword", 1],
				["hybrid", 2],
				["semantic", 2],
			],
		);
		assert.equal(report.results[1].modes.semantic?.rank, 1, "voltage found by meaning");

		const zh = messages("zh").evalText;
		assert.deepEqual(summaryRows(report, zh)[1].slice(0, 5), ["关键词+语义", "100%", "100%", "100%", "1.00"]);
		const file = writeReport(root, report, zh);
		const text = readFileSync(file, "utf8");
		assert.match(text, /^# 知识库评测 · 2 个有答案的问题 · 1 个没有答案的问题/);
		assert.match(text, /\| maximum voltage of the chip \| xr100-manual\.pdf p\.1 \| 未找到/);
		assert.match(text, /\| 今天午饭吃什么 \| - \| 空（正确） \|/);
	} finally {
		kb.close();
		rmSync(root, { recursive: true, force: true });
	}
});
