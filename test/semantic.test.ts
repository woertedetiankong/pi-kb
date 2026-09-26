import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_SEMANTIC, defaultMinScore } from "../src/config.ts";
import { KnowledgeBase } from "../src/kb.ts";
import { fuse } from "../src/search.ts";
import { profileFor } from "../src/semantic/models.ts";
import { formatSize } from "../src/index.ts";
import { ApiProvider, apiKeyEnv, folderSize, LocalProvider, removeLocalModel, SemanticError } from "../src/semantic/providers.ts";

const fixtures = join(import.meta.dirname, "fixtures");

/** A fake embeddings service: one dimension per concept, in Chinese and English alike. */
const CONCEPTS = [/电压|伏|voltage|volt/gi, /spi|时钟|clock|分频|divider/gi, /擦除|烧录|erase|flash/gi, /面|lunch|noodle/gi];
function embedText(text: string): number[] {
	return [...CONCEPTS.map((re) => (text.match(re) ?? []).length), 0.01];
}

let server: Server;
let baseUrl: string;
const requests: { auth?: string; model: string; inputs: number; first: string }[] = [];
let failNext = 0;

before(async () => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const { model, input } = JSON.parse(body) as { model: string; input: string[] };
			requests.push({ auth: req.headers.authorization, model, inputs: input.length, first: input[0] });
			if (failNext > 0) {
				failNext--;
				res.writeHead(model === "broken" ? 400 : 429).end("slow down");
				return;
			}
			if (model === "broken") {
				res.writeHead(400).end("bad model");
				return;
			}
			// Answer out of order: the provider must sort by index.
			const data = input.map((text, index) => ({ index, embedding: embedText(text) })).reverse();
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

test("fuse ranks by reciprocal rank and marks where each chunk matched", () => {
	const fused = fuse([1, 2, 3], [3, 4]);
	assert.deepEqual(
		fused.map((f) => [f.chunk, f.match]),
		[
			[3, "both"],
			[1, "keyword"],
			[2, "keyword"],
			[4, "semantic"],
		],
		"equal ranks tie; the keyword list comes first",
	);
});

test("API provider: sorts by index, normalizes, sends the key, retries rate limits", async () => {
	const provider = new ApiProvider({ baseUrl: `${baseUrl}/`, model: "m", apiKey: "secret" });
	failNext = 1;
	const [a, b] = await provider.embed(["电压 电压", "clock"], "passage");
	assert.ok(Math.abs(a.reduce((s, x) => s + x * x, 0) - 1) < 1e-5, "unit length");
	assert.ok(a[0] > 0.99 && b[1] > 0.99, "order follows the input, not the response");
	assert.equal(requests.at(-1)?.auth, "Bearer secret");
	assert.equal(requests.filter((r) => r.model === "m").length, 2, "one retry after 429");

	const saved = { kb: process.env.PI_KB_EMBEDDING_API_KEY, openai: process.env.OPENAI_API_KEY };
	delete process.env.PI_KB_EMBEDDING_API_KEY;
	process.env.OPENAI_API_KEY = "sk-test";
	// OPENAI_API_KEY only counts for OpenAI itself.
	const remote = new ApiProvider({ baseUrl: "https://api.example.com/v1", model: "m" });
	await assert.rejects(remote.embed(["x"], "query"), (e: unknown) => e instanceof SemanticError && e.problem === "no_api_key");
	let sent: string | undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sent = (init.headers as Record<string, string>).authorization;
		return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
	}) as typeof fetch;
	try {
		await new ApiProvider(DEFAULT_SEMANTIC.api).embed(["x"], "query");
		assert.equal(sent, "Bearer sk-test", "the default OpenAI endpoint uses OPENAI_API_KEY");
		assert.equal(apiKeyEnv("https://api.openai.com/v1/"), "OPENAI_API_KEY", "the settings page can say where the key comes from");
		assert.equal(apiKeyEnv("https://api.example.com/v1"), undefined);
		process.env.PI_KB_EMBEDDING_API_KEY = "pk";
		assert.equal(apiKeyEnv("https://api.example.com/v1"), "PI_KB_EMBEDDING_API_KEY");
	} finally {
		globalThis.fetch = realFetch;
		for (const [name, value] of [["PI_KB_EMBEDDING_API_KEY", saved.kb], ["OPENAI_API_KEY", saved.openai]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("hybrid search finds meaning across languages and keeps vectors in step with documents", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-sem-"));
	const kb = new KnowledgeBase(root);
	try {
		await kb.addFile(join(fixtures, "xr100-manual.pdf"));
		await kb.addFile(join(fixtures, "spi-lesson.md"), { wiki: true });
		assert.equal(kb.search("maximum voltage").length, 0, "keywords alone cannot bridge languages");
		assert.deepEqual(await kb.find("maximum voltage"), [], "semantic search is off by default");

		kb.updateConfig({ semantic: { ...DEFAULT_SEMANTIC, provider: "api", api: { baseUrl, model: "concepts" } } });
		await kb.indexSemantic();
		const { done, total } = kb.vectors.progress(`api:${baseUrl}|concepts`);
		assert.ok(total > 0 && done === total, `all chunks embedded (${done}/${total})`);
		assert.equal(kb.indexer.status.state, "idle");

		const [voltage] = await kb.find("maximum voltage");
		assert.equal(voltage.title, "xr100-manual.pdf");
		assert.equal(voltage.page, 1);
		assert.equal(voltage.match, "semantic");
		const clock = await kb.find("CTRL_REG 时钟", { collection: "wiki" });
		assert.equal(clock[0].collection, "wiki");
		assert.equal(clock[0].match, "both");

		// A similarity floor drops meaning-only hits (bge-m3 gets one by default).
		assert.equal(defaultMinScore("BAAI/bge-m3"), 0.51);
		assert.equal(defaultMinScore("onnx-community/Qwen3-Embedding-0.6B-ONNX"), 0.43);
		assert.equal(defaultMinScore("Qwen/Qwen3-Embedding-8B"), undefined, "only measured sizes get a floor");
		assert.equal(defaultMinScore("text-embedding-3-small"), undefined);
		kb.updateConfig({ semantic: { ...kb.config.semantic, minScore: 1.1 } });
		assert.deepEqual(await kb.find("maximum voltage"), [], "a floor above every cosine drops all meaning-only hits");
		kb.updateConfig({ semantic: { ...kb.config.semantic, minScore: undefined } });

		// Removing a document removes its vectors; re-importing embeds again.
		const pdf = kb.store.listDocs("docs")[0];
		kb.remove(pdf.id);
		assert.ok(kb.vectors.progress(`api:${baseUrl}|concepts`).done < done);
		await kb.addFile(join(fixtures, "xr100-manual.pdf"));
		await kb.indexSemantic();
		assert.equal(kb.vectors.progress(`api:${baseUrl}|concepts`).done, done);

		// Another model makes old vectors stale: they are dropped and rebuilt.
		kb.updateConfig({ semantic: { ...kb.config.semantic, api: { baseUrl, model: "concepts-v2" } } });
		await kb.indexSemantic();
		assert.equal(kb.vectors.progress(`api:${baseUrl}|concepts-v2`).done, done);
		assert.equal(kb.vectors.progress(`api:${baseUrl}|concepts`).done, 0);

		// A failing service leaves keyword search working and reports the error.
		kb.updateConfig({ semantic: { ...kb.config.semantic, api: { baseUrl, model: "broken" } } });
		await kb.indexSemantic();
		assert.equal(kb.indexer.status.state, "error");
		assert.match(kb.indexer.status.error ?? "", /400/);
		assert.equal((await kb.find("CTRL_REG"))[0].match, "keyword");

		kb.updateConfig({ semantic: { ...kb.config.semantic, provider: "off" } });
		assert.equal(kb.indexer.status.state, "off");
	} finally {
		kb.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("model profiles: Qwen3 queries get the instruction locally and over an API; documents never do", async () => {
	const qwen = profileFor("onnx-community/Qwen3-Embedding-0.6B-ONNX");
	assert.equal(qwen.pooling, "last_token");
	assert.match(qwen.queryPrefix, /^Instruct: .*\nQuery:$/);
	assert.equal(qwen.revision, "c25a394dd583836952667c12f008335071b3f43d", "local download pinned to the benchmarked commit");
	assert.equal(profileFor("Xenova/bge-m3").pooling, "cls");
	assert.deepEqual(profileFor("some-new-model"), { pooling: "mean", queryPrefix: "", revision: undefined });

	const api = new ApiProvider({ baseUrl, model: "Qwen/Qwen3-Embedding-0.6B" });
	await api.embed(["芯片最高电压"], "query");
	assert.equal(requests.at(-1)?.first, `${qwen.queryPrefix}芯片最高电压`);
	await api.embed(["手册正文"], "passage");
	assert.equal(requests.at(-1)?.first, "手册正文");

	const local = new LocalProvider({ model: "onnx-community/Qwen3-Embedding-0.6B-ONNX", runtimeDir: "/nonexistent", cacheDir: "/nonexistent" });
	assert.equal(local.key, "local:onnx-community/Qwen3-Embedding-0.6B-ONNX#last_token");
	await assert.rejects(local.embed(["x"], "query"), (e: unknown) => e instanceof SemanticError && e.problem === "runtime_missing");
});

test("removing the local model deletes only runtime/ and models/, not what their links point to", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-remove-"));
	try {
		const outside = join(root, "outside.bin");
		writeFileSync(outside, Buffer.alloc(5000));
		mkdirSync(join(root, "runtime", "node_modules"), { recursive: true });
		writeFileSync(join(root, "runtime", "node_modules", "lib.js"), Buffer.alloc(3000));
		symlinkSync(outside, join(root, "runtime", "link.bin"));
		mkdirSync(join(root, "models"));
		writeFileSync(join(root, "models", "model.onnx"), Buffer.alloc(2000));
		mkdirSync(join(root, "wiki"));
		writeFileSync(join(root, "wiki", "note.md"), "keep");

		assert.ok(folderSize(join(root, "runtime")) < 4000, "the link counts as a link, not as its 5000-byte target");
		const freed = removeLocalModel(root);
		assert.ok(freed >= 5000 && freed < 6000, `freed ${freed}`);
		assert.equal(existsSync(join(root, "runtime")), false);
		assert.equal(existsSync(join(root, "models")), false);
		assert.equal(readFileSync(join(root, "wiki", "note.md"), "utf8"), "keep");
		assert.equal(statSync(outside).size, 5000);
		assert.equal(removeLocalModel(root), 0, "nothing left to remove");

		assert.equal(formatSize(1_130_000_000), "1.1 GB");
		assert.equal(formatSize(614_000_000), "614 MB");
		assert.equal(formatSize(512), "512 B");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("config changed by another pi window is picked up, and saving starts from it", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-reload-"));
	const kb = new KnowledgeBase(root);
	try {
		assert.equal(kb.reloadConfig(), false, "nothing changed");
		kb.updateConfig({ ocrLanguage: "eng" });
		assert.equal(kb.reloadConfig(), false, "its own write is not a change");

		// Another process turns the knowledge base off and switches to an API model.
		const file = join(root, "config.json");
		const other = JSON.parse(readFileSync(file, "utf8"));
		other.enabled = false;
		other.ocrLanguage = "eng+jpn";
		other.semantic = { ...other.semantic, provider: "api", api: { baseUrl: "http://127.0.0.1:9/v1", model: "elsewhere" } };
		writeFileSync(file, JSON.stringify(other));
		const later = new Date(Date.now() + 5000);
		utimesSync(file, later, later);
		assert.equal(kb.reloadConfig(), true);
		assert.equal(kb.config.enabled, false);
		assert.equal(kb.config.semantic.api.model, "elsewhere");
		assert.equal(kb.indexer.status.state === "off", false, "the new provider is in use");
		const ocr = () => (kb.converter as unknown as { options: { ocrLanguage: string } }).options.ocrLanguage;
		assert.equal(ocr(), "eng+jpn", "OCR settings apply without a restart too");

		// A write here keeps what the other window saved.
		writeFileSync(file, JSON.stringify({ ...other, language: "en" }));
		const later2 = new Date(Date.now() + 10_000);
		utimesSync(file, later2, later2);
		kb.updateConfig({ ocrLanguage: "chi_sim" });
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(saved.language, "en");
		assert.equal(saved.ocrLanguage, "chi_sim");
		assert.equal(ocr(), "chi_sim");
		kb.updateConfig({ semantic: { ...kb.config.semantic, provider: "off" } });
	} finally {
		kb.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("with semantic search, a note in the other language counts as similar, and lint pairs notes that find each other", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-sem-similar-"));
	const kb = new KnowledgeBase(root);
	try {
		const { Library } = await import("../src/library.ts");
		const lib = new Library(kb);
		const chinese = (await kb.addFile(join(fixtures, "spi-lesson.md"), { wiki: true })).doc!;
		kb.writeNote(kb.prepareNote({ title: "Lunch", content: "Noodles.", tags: ["food"] }));
		assert.deepEqual(await lib.similarNotes("SPI clock divider gotcha"), [], "keywords alone miss the Chinese note");

		kb.updateConfig({ semantic: { ...DEFAULT_SEMANTIC, provider: "api", api: { baseUrl, model: "concepts" } } });
		await kb.indexSemantic();
		assert.deepEqual(await lib.similarNotes("SPI clock divider gotcha"), [], "no similarity floor: the closest notes, related or not, are not trusted");
		kb.updateConfig({ semantic: { ...kb.config.semantic, minScore: 0.3 } });
		const found = await lib.similarNotes("SPI clock divider gotcha");
		assert.deepEqual(found.map((d) => [d.id, d.why]), [[chinese.id, "search"]]);

		const english = kb.writeNote(kb.prepareNote({ title: "Clock divider must be set first", content: "The clock divider resets to 1; set it to 4 before using the flash.", tags: ["spi"] }));
		await kb.indexSemantic();
		const report = await lib.checkWiki();
		assert.deepEqual(report.duplicates.map((pair) => pair.map((d) => d.id).sort()), [[chinese.id, english.id].sort()]);
	} finally {
		kb.close();
		rmSync(root, { recursive: true, force: true });
	}
});
