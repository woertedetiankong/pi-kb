import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./notes.ts";
import type { SearchHit } from "./store.ts";

/**
 * Retrieval evaluation: does the page that answers a question come back, and how high?
 * Deterministic and free (no model calls), so modes and settings can be compared quickly.
 */

export interface Expected {
	/** Matched case-insensitively against the document or note title, or equal to its id. */
	doc: string;
	page?: number;
}

export interface EvalQuestion {
	line: number;
	question: string;
	/** Empty: the knowledge base should have no answer. */
	expected: Expected[];
}

export type EvalMode = "keyword" | "hybrid" | "semantic";

export interface ModeResult {
	mode: EvalMode;
	answerable: number;
	hit1: number;
	hit3: number;
	hit8: number;
	mrr: number;
	unanswerable: number;
	/** Questions without an answer that correctly came back empty. */
	quiet: number;
	avgMs: number;
}

export interface QuestionResult {
	question: EvalQuestion;
	/** Per mode: 1-based rank of the first correct hit (0 = not found), and what came first. */
	modes: Partial<Record<EvalMode, { rank: number; count: number; top?: string }>>;
}

export interface EvalReport {
	questions: number;
	modes: ModeResult[];
	results: QuestionResult[];
}

const LIMIT = 8;

export function questionsFile(root: string): string {
	return join(root, "eval", "questions.txt");
}

export const TEMPLATE = `# pi-kb 评测问题 / pi-kb evaluation questions
#
# 每行一个问题：问题 | 正确答案所在的资料或笔记
#   - 写文件名或笔记标题的一部分即可，可以加页码：manual.pdf p.12
#   - 有多个可接受的答案时用 ; 分隔
#   - 知识库里没有答案的问题，答案写 -
# 以 # 开头的行是注释。/kb eval 运行评测，/kb eval draft 让 agent 帮你起草问题。
#
# One question per line: question | document or note that answers it
#   - part of the file name or note title, optionally with a page: manual.pdf p.12
#   - separate acceptable answers with ;
#   - for questions the knowledge base cannot answer, write -
# Lines starting with # are comments. Run /kb eval; /kb eval draft asks the agent to draft questions.
#
# 例 / examples:
# 芯片的最大供电电压是多少 | xr100-manual.pdf p.1
# how do I configure the SPI clock divider | xr100-manual.pdf p.2; SPI 时钟分频踩坑
# 今天午饭吃什么 | -
`;

/** Parse the questions file; bad lines are reported, not fatal. */
export function parseQuestions(text: string): { questions: EvalQuestion[]; errors: number[] } {
	const questions: EvalQuestion[] = [];
	const errors: number[] = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) return;
		const bar = line.lastIndexOf("|");
		const question = bar > 0 ? line.slice(0, bar).trim() : "";
		const answer = bar > 0 ? line.slice(bar + 1).trim() : "";
		if (!question || !answer) {
			errors.push(i + 1);
			return;
		}
		const expected =
			answer === "-"
				? []
				: answer
						.split(/[;；]/)
						.map((part) => part.trim())
						.filter(Boolean)
						.map((part) => {
							const m = /^(.*?)\s+p\.?\s*(\d+)$/i.exec(part);
							return m ? { doc: m[1].trim(), page: Number(m[2]) } : { doc: part };
						});
		questions.push({ line: i + 1, question, expected });
	});
	return { questions, errors };
}

export function matches(hit: Pick<SearchHit, "title" | "docId" | "page">, expected: Expected[]): boolean {
	return expected.some(
		(e) =>
			(hit.docId === e.doc || hit.title.toLowerCase().includes(e.doc.toLowerCase())) &&
			(e.page === undefined || hit.page === e.page),
	);
}

/** What an evaluation searches: one knowledge base, or the project and global ones together as the agent does. */
export interface Searchable {
	semanticReady(): boolean;
	search(query: string, options: { limit?: number }): SearchHit[] | Promise<SearchHit[]>;
	find(query: string, options: { limit?: number }): Promise<SearchHit[]>;
	findSemantic(query: string, options: { limit?: number }): Promise<SearchHit[]>;
}

export async function runEval(kb: Searchable, questions: EvalQuestion[], onProgress?: (done: number, total: number) => void): Promise<EvalReport> {
	const modes: EvalMode[] = kb.semanticReady() ? ["keyword", "hybrid", "semantic"] : ["keyword"];
	const search: Record<EvalMode, (q: string) => Promise<SearchHit[]>> = {
		keyword: async (q) => kb.search(q, { limit: LIMIT }),
		hybrid: (q) => kb.find(q, { limit: LIMIT }),
		semantic: (q) => kb.findSemantic(q, { limit: LIMIT }),
	};
	const results: QuestionResult[] = questions.map((question) => ({ question, modes: {} }));
	const time: Record<string, number> = {};
	let done = 0;
	for (const result of results) {
		for (const mode of modes) {
			const started = performance.now();
			const hits = await search[mode](result.question.question);
			time[mode] = (time[mode] ?? 0) + performance.now() - started;
			const rank = hits.findIndex((h) => matches(h, result.question.expected)) + 1;
			const first = hits[0];
			result.modes[mode] = { rank, count: hits.length, top: first ? (first.page ? `${first.title} p.${first.page}` : first.title) : undefined };
		}
		onProgress?.(++done, results.length);
	}
	const summary = modes.map((mode): ModeResult => {
		const answerable = results.filter((r) => r.question.expected.length);
		const unanswerable = results.filter((r) => !r.question.expected.length);
		const ranks = answerable.map((r) => r.modes[mode]?.rank ?? 0);
		const within = (k: number) => ranks.filter((rank) => rank > 0 && rank <= k).length;
		return {
			mode,
			answerable: answerable.length,
			hit1: within(1),
			hit3: within(3),
			hit8: within(LIMIT),
			mrr: ranks.length ? ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length : 0,
			unanswerable: unanswerable.length,
			quiet: unanswerable.filter((r) => r.modes[mode]?.count === 0).length,
			avgMs: results.length ? (time[mode] ?? 0) / results.length : 0,
		};
	});
	return { questions: results.length, modes: summary, results };
}

export interface ReportText {
	modeNames: Record<EvalMode, string>;
	columns: [string, string, string, string, string, string, string];
	title: (answerable: number, unanswerable: number) => string;
	detailsTitle: string;
	detailColumns: [string, string];
	notFound: string;
	empty: string;
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

/** Summary rows for the terminal: one line per mode. */
export function summaryRows(report: EvalReport, text: ReportText): string[][] {
	return report.modes.map((m) => [
		text.modeNames[m.mode],
		pct(m.hit1, m.answerable),
		pct(m.hit3, m.answerable),
		pct(m.hit8, m.answerable),
		m.answerable ? m.mrr.toFixed(2) : "–",
		pct(m.quiet, m.unanswerable),
		`${Math.round(m.avgMs)}ms`,
	]);
}

/** Full Markdown report with a row per question, saved next to the questions file. */
export function writeReport(root: string, report: EvalReport, text: ReportText): string {
	const dir = join(root, "eval", "reports");
	mkdirSync(dir, { recursive: true });
	const stamp = now().replace(/[: ]/g, "-");
	const file = join(dir, `${stamp}.md`);
	const answerable = report.modes[0]?.answerable ?? 0;
	const unanswerable = report.modes[0]?.unanswerable ?? 0;
	const table = (header: string[], rows: string[][]) =>
		[`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
	const cell = (s: string) => s.replace(/\|/g, "\\|");
	const modes = report.modes.map((m) => m.mode);
	const details = report.results.map((r) => {
		const expected = r.question.expected.length ? r.question.expected.map((e) => (e.page ? `${e.doc} p.${e.page}` : e.doc)).join("; ") : "-";
		const perMode = modes.map((mode) => {
			const res = r.modes[mode];
			if (!res) return "";
			if (!r.question.expected.length) return res.count ? `${res.count} · ${cell(res.top ?? "")}` : text.empty;
			return res.rank ? `#${res.rank}` : `${text.notFound}${res.top ? ` · ${cell(res.top)}` : ""}`;
		});
		return [cell(r.question.question), cell(expected), ...perMode];
	});
	const body = [
		`# ${text.title(answerable, unanswerable)}`,
		"",
		now(),
		"",
		table(text.columns, summaryRows(report, text)),
		"",
		`## ${text.detailsTitle}`,
		"",
		table([...text.detailColumns, ...modes.map((m) => text.modeNames[m])], details),
		"",
	].join("\n");
	writeFileSync(file, body);
	return file;
}

/** Create the questions file from the template unless it exists. Returns true when created. */
export function initQuestions(root: string): boolean {
	const file = questionsFile(root);
	if (existsSync(file)) return false;
	mkdirSync(join(root, "eval"), { recursive: true });
	writeFileSync(file, TEMPLATE);
	return true;
}

export function readQuestions(root: string): string | undefined {
	const file = questionsFile(root);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
