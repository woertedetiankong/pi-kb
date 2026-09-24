/**
 * Check how a real model uses the knowledge base: does it call kb_search and kb_note on its own,
 * and does it cite exactly what kb_search printed?
 *
 *   node scripts/model-check/run.ts [--model openai-codex/gpt-6-luna] [--runs 2] [--only id,id] [--jobs 4] [--out dir]
 *
 * Every run gets a fresh copy of a small fictional knowledge base and an empty project folder,
 * and runs `pi -p --mode json` with only this extension loaded. Your own ~/.pi/kb is not touched.
 * Without a UI, kb_note saves without asking, into the throwaway copy.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { KnowledgeBase } from "../../src/kb.ts";
import { type Expect, type Scenario, scenarios } from "./scenarios.ts";

const repo = join(import.meta.dirname, "..", "..");
const { values: args } = parseArgs({
	options: {
		model: { type: "string", default: "openai-codex/gpt-6-luna" },
		runs: { type: "string", default: "2" },
		only: { type: "string" },
		jobs: { type: "string", default: "4" },
		out: { type: "string" },
		thinking: { type: "string" },
	},
});

interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	result: string;
}

interface RunResult {
	scenario: Scenario;
	run: number;
	calls: ToolCall[];
	answer: string;
	problems: string[];
	seconds: number;
	cost: number;
}

async function buildSeed(dir: string): Promise<string[]> {
	const kb = new KnowledgeBase(dir);
	const docs = [
		join(repo, "test/fixtures/xr100-manual.pdf"),
		join(repo, "scripts/model-check/corpus/orbit-runbook.md"),
		join(repo, "scripts/model-check/corpus/yf20-faq.md"),
		// Unrelated documents so the right answer has to be found, not just listed.
		...["tmux.md", "themes.md", "keybindings.md"].map((f) => join(repo, "node_modules/@earendil-works/pi-coding-agent/docs", f)),
	];
	for (const file of docs) {
		const r = await kb.addFile(file);
		if (r.status !== "added") throw new Error(`${file}: ${r.status} ${r.message ?? r.reason ?? ""}`);
	}
	const note = await kb.addFile(join(repo, "test/fixtures/spi-lesson.md"), { wiki: true });
	if (note.status !== "added") throw new Error(`spi-lesson.md: ${note.status}`);
	const titles = kb.store.listDocs().map((d) => d.title);
	kb.close();
	return titles;
}

function runPi(cwd: string, kbDir: string, prompt: string): Promise<string> {
	const piArgs = ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"];
	piArgs.push("-e", join(repo, "src/index.ts"), "--model", args.model!);
	if (args.thinking) piArgs.push("--thinking", args.thinking);
	piArgs.push("--", prompt);
	return new Promise((resolve, reject) => {
		const child = spawn("pi", piArgs, { cwd, env: { ...process.env, PI_KB_DIR: kbDir, PI_KB_LANG: "en" }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => child.kill(), 10 * 60_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolve(out) : reject(new Error(`pi exited ${code}: ${err.slice(-500)}`));
		});
	});
}

/** Events from `pi --mode json`, read loosely. */
type Json = any;

function parseRun(jsonl: string): { calls: ToolCall[]; answer: string; cost: number } {
	const events = jsonl
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Json);
	// Each agent_end carries the messages of its own run; the kb_note reminder adds a second run.
	const ends = events.filter((e) => e.type === "agent_end");
	if (!ends.length) throw new Error("no agent_end event");
	const calls: ToolCall[] = [];
	const byId = new Map<string, ToolCall>();
	const texts: string[] = [];
	let cost = 0;
	for (const msg of ends.flatMap((e) => e.messages as Json[])) {
		if (msg.role === "assistant") {
			cost += msg.usage?.cost?.total ?? 0;
			for (const part of msg.content ?? []) {
				if (part.type === "text") texts.push(part.text);
				if (part.type === "toolCall") {
					const call = { name: part.name, args: part.arguments ?? {}, result: "" };
					calls.push(call);
					byId.set(part.id, call);
				}
			}
		}
		if (msg.role === "toolResult") {
			const call = byId.get(msg.toolCallId);
			if (call) call.result = (msg.content ?? []).map((p: Json) => p.text ?? "").join("\n");
		}
	}
	// The extension's hidden kb_note reminder (see src/nudge.ts) is not among the messages.
	if (events.some((e) => e.type === "entry_appended" && e.entry?.customType === "kb-note-nudge")) calls.push({ name: "nudge", args: {}, result: "" });
	return { calls, answer: texts.join("\n\n"), cost };
}

/** Bracketed references to knowledge base documents, e.g. [manual.pdf p.12] or [SPI 时钟分频踩坑]. */
function citations(answer: string, titles: string[]): string[] {
	const found = [...answer.matchAll(/\[([^\[\]\n]+)\](?!\()/g)].map((m) => m[0]);
	return found.filter((c) => titles.some((t) => c.slice(1).startsWith(t)) || /\sp\.\s?\d/.test(c));
}

/** Mentions of a document with a page outside the [title p.N] form, e.g. "xr100-manual.pdf, page 1". */
function looseCitations(answer: string, titles: string[]): string[] {
	const out: string[] = [];
	for (const t of titles) {
		const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const m of answer.matchAll(new RegExp(`${esc}[^\\n\\]]{0,12}?(?:page|p\\.|第)\\s*\\d+`, "gi"))) {
			if (!answer.includes(`[${m[0]}]`) && !/^[^\s,，(（]+ p\.\d+$/.test(m[0])) out.push(m[0]);
		}
	}
	return out;
}

function check(s: Scenario, calls: ToolCall[], answer: string, titles: string[]): string[] {
	const problems: string[] = [];
	const has = (name: string) => calls.some((c) => c.name === name);
	const expect = (what: Expect, name: string) => {
		if (what === "required" && !has(name)) problems.push(`no ${name}`);
		if (what === "forbidden" && has(name)) problems.push(`unwanted ${name}`);
	};
	expect(s.search, "kb_search");
	expect(s.note, "kb_note");
	if (s.note === "forbidden" && has("nudge")) problems.push("unwanted nudge");
	if (s.noteMode) {
		const notes = calls.filter((c) => c.name === "kb_note");
		if (notes.length && !notes.some((c) => (c.args.mode ?? "create") === s.noteMode && c.args.id)) {
			problems.push(`kb_note mode ${notes.map((c) => c.args.mode ?? "create").join("/")}, wanted ${s.noteMode} with id`);
		}
	}
	const cited = citations(answer, titles);
	// Anything cited must have been printed by kb_search or kb_read in this run.
	const printed = calls.filter((c) => c.name === "kb_search" || c.name === "kb_read").map((c) => c.result).join("\n");
	for (const c of cited) {
		const bare = c.replace(/\s*p\.\s*\d+(?:[-–]\d+)?\]$/, "]");
		const readTitle = calls.some((call) => call.name === "kb_read" && call.result.startsWith(`${bare.slice(1, -1)} (`));
		if (!printed.includes(c) && !readTitle) problems.push(`citation not from tools: ${c}`);
	}
	for (const want of s.cites ?? []) if (!cited.includes(want) && !answer.includes(want)) problems.push(`missing citation ${want}`);
	if (s.citesAny && !s.citesAny.some((want) => answer.includes(want))) problems.push(`missing any of ${s.citesAny.join(" ")}`);
	if (s.noCitations && cited.length) problems.push(`cited ${cited.join(" ")}`);
	for (const loose of looseCitations(answer, titles)) problems.push(`loose citation "${loose}"`);
	if (s.answer && !s.answer.test(answer)) problems.push(`answer lacks ${s.answer}`);
	return problems;
}

async function pool<T>(items: T[], jobs: number, fn: (item: T) => Promise<void>) {
	const queue = [...items];
	await Promise.all(Array.from({ length: jobs }, async () => {
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
	}));
}

const out = args.out ?? mkdtempSync(join(tmpdir(), "pi-kb-model-check-"));
mkdirSync(out, { recursive: true });
const seed = join(out, "seed-kb");
const titles = await buildSeed(seed);
const only = args.only?.split(",");
const chosen = scenarios.filter((s) => !only || only.includes(s.id));
const runs = Number(args.runs);
const jobs = chosen.flatMap((scenario) => Array.from({ length: runs }, (_, i) => ({ scenario, run: i + 1 })));
const results: RunResult[] = [];
console.log(`${args.model}: ${chosen.length} scenarios × ${runs} runs → ${out}`);

await pool(jobs, Number(args.jobs), async ({ scenario, run }) => {
	const dir = join(out, `${scenario.id}-${run}`);
	const project = join(dir, "project");
	mkdirSync(project, { recursive: true });
	for (const [name, text] of Object.entries(scenario.files ?? {})) writeFileSync(join(project, name), text);
	cpSync(seed, join(dir, "kb"), { recursive: true });
	const started = Date.now();
	let result: RunResult;
	try {
		const jsonl = await runPi(project, join(dir, "kb"), scenario.prompt);
		writeFileSync(join(dir, "events.jsonl"), jsonl);
		const { calls, answer, cost } = parseRun(jsonl);
		result = { scenario, run, calls, answer, cost, problems: check(scenario, calls, answer, titles), seconds: (Date.now() - started) / 1000 };
	} catch (error) {
		result = { scenario, run, calls: [], answer: "", cost: 0, problems: [`error: ${(error as Error).message}`], seconds: (Date.now() - started) / 1000 };
	}
	results.push(result);
	const tools = result.calls.map((c) => c.name.replace("kb_", "") + (c.name === "kb_note" && c.args.mode ? `:${c.args.mode}` : "")).join(",");
	console.log(`${result.problems.length ? "✗" : "✓"} ${scenario.id} #${run} [${tools || "no tools"}] ${result.problems.join("; ")}`);
});

results.sort((a, b) => chosen.indexOf(a.scenario) - chosen.indexOf(b.scenario) || a.run - b.run);
const passed = results.filter((r) => !r.problems.length).length;
const report = [
	`# pi-kb model check — ${args.model}`,
	"",
	`${passed}/${results.length} runs passed · cost $${results.reduce((n, r) => n + r.cost, 0).toFixed(2)}`,
	"",
	"| scenario | run | tools | problems | s |",
	"|---|---|---|---|---|",
	...results.map((r) => {
		const tools = r.calls.map((c) => `${c.name}(${JSON.stringify(c.args.query ?? c.args.id ?? c.args.title ?? "")})`).join(" ");
		return `| ${r.scenario.id} | ${r.run} | ${tools.replace(/\|/g, "\\|")} | ${r.problems.join("; ").replace(/\|/g, "\\|") || "ok"} | ${r.seconds.toFixed(0)} |`;
	}),
	"",
	...results.flatMap((r) => [`## ${r.scenario.id} #${r.run}`, "", `> ${r.scenario.prompt}`, "", r.answer, ""]),
].join("\n");
writeFileSync(join(out, "report.md"), report);
writeFileSync(join(out, "results.json"), JSON.stringify(results.map(({ scenario, ...r }) => ({ id: scenario.id, ...r })), null, 2));
console.log(`\n${passed}/${results.length} runs passed. Report: ${join(out, "report.md")}`);
