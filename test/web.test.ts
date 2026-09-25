import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHub, sharedHub, type WebApp, type WebHub } from "../src/hub.ts";
import { KnowledgeBase } from "../src/kb.ts";
import { ImportQueue } from "../src/queue.ts";
import { KbWebApp } from "../src/web.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const TOKEN = "a".repeat(32);
let root: string;
let kb: KnowledgeBase;
let hub: WebHub;
let base: string;
let enabled = true;
let changes = 0;
let localCalls = 0;
let installError: string | undefined;

const fakeSessions: WebApp = {
	id: "sessions",
	order: 10,
	title: { zh: "会话", en: "Sessions" },
	languages: ["zh"],
	page: async () => "<p>sessions</p>",
	handle: async (req) => ({ app: "sessions", path: req.path }),
};

before(async () => {
	process.env.PI_KB_TESSDATA ??= join(tmpdir(), "pi-kb-test-tessdata");
	root = mkdtempSync(join(tmpdir(), "pi-kb-web-"));
	kb = new KnowledgeBase(root);
	const queue = new ImportQueue((item, signal) => kb.addFile(item.path, { ...item, signal }), () => {});
	const app = new KbWebApp(
		{
			kb: () => kb,
			enabled: () => enabled,
			setEnabled: (on) => { enabled = on; },
			changed: () => { changes++; },
			enqueue: (item) => queue.enqueue([item]),
			importStatus: () => ({ ...queue.status, active: queue.active }),
			useLocal: async () => {
				localCalls++;
				return true;
			},
			localSetup: () => (installError ? { installError } : {}),
			forgetInstallError: () => {
				installError = undefined;
			},
			model: () => undefined,
		},
		join(import.meta.dirname, "..", "web", "kb.html"),
	);
	hub = createHub({ agentDir: root, token: TOKEN, port: 0 });
	hub.mount(app);
	hub.mount(fakeSessions);
	await hub.start();
	base = new URL(hub.url("kb") ?? "").origin;
});
after(async () => {
	await hub.close();
	kb.close();
	rmSync(root, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit = {}) =>
	fetch(base + path, { ...init, headers: { "x-token": TOKEN, ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) =>
	call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("hub serves each app's page, the shared client and a token-guarded app list", async () => {
	assert.match(hub.url("kb") ?? "", /\/kb\/#token=a{32}$/);
	assert.match(await (await fetch(`${base}/kb/`)).text(), /<nav id="pi-web-nav">/);
	assert.equal(await (await fetch(`${base}/`)).text(), "<p>sessions</p>", "/ goes to the lowest-order app");
	assert.equal((await fetch(`${base}/kb`, { redirect: "manual" })).headers.get("location"), "/kb/");
	assert.match(await (await fetch(`${base}/hub.js`)).text(), /pi-web-nav/);
	assert.equal((await fetch(`${base}/api/hub/apps`)).status, 401);
	const { apps } = await (await call("/api/hub/apps")).json();
	assert.deepEqual(apps.map((a: { id: string }) => a.id), ["sessions", "kb"]);
	assert.deepEqual(await (await call("/api/sessions/x")).json(), { app: "sessions", path: "/x" }, "requests reach the right app");
	assert.equal((await call("/api/nope/x")).status, 404);
});

test("hub rejects foreign Host headers", async () => {
	const port = Number(new URL(base).port);
	const status = await new Promise<number>((resolve, reject) =>
		request({ host: "127.0.0.1", port, path: "/api/kb/status", headers: { "x-token": TOKEN, host: `evil.example:${port}` } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		})
			.on("error", reject)
			.end(),
	);
	assert.equal(status, 403);
});

/** Upload through the background queue and wait for the result, as the page does. */
async function upload(name: string, body: string | Buffer, query = "") {
	const res = await (await call(`/api/kb/upload?name=${encodeURIComponent(name)}${query}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: body as BodyInit })).json();
	if (!res.job) return res;
	for (;;) {
		const r = await (await call(`/api/kb/import?job=${res.job}`)).json();
		if (r.done) return { result: r.results[0] };
		const { imports } = await (await call("/api/kb/status")).json();
		assert.equal(typeof imports.active, "boolean", "the page can show progress");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("upload, list, search, read pages and fetch the original PDF", async () => {
	const pdf = readFileSync(join(fixtures, "xr100-manual.pdf"));
	const up = await upload("xr100-manual.pdf", pdf);
	assert.equal(up.result.status, "added");
	assert.equal(up.result.path, "xr100-manual.pdf", "results name the file, not the temporary path");
	assert.equal(up.result.doc.source, "upload:xr100-manual.pdf");
	assert.ok(changes > 0, "the terminal status bar is told to refresh");
	const id = up.result.doc.id;

	const { docs } = await (await call("/api/kb/docs")).json();
	assert.deepEqual(docs.map((d: { title: string }) => d.title), ["xr100-manual.pdf"]);
	const { hits } = await (await call(`/api/kb/search?q=${encodeURIComponent("CTRL_REG 地址")}`)).json();
	assert.equal(hits[0].page, 2);
	const doc = await (await call(`/api/kb/doc?id=${id}`)).json();
	assert.match(doc.text, /<!-- kb:page 2 -->/);

	const file = await call(`/api/kb/file?id=${id}`);
	assert.equal(file.headers.get("content-type"), "application/pdf");
	assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
	assert.equal((await call("/api/kb/file?id=k-000000000000")).status, 400);

	const bad = await upload("x.xyz", "x");
	assert.equal(bad.result.reason, "unsupported");
	assert.equal((await call("/api/kb/import?job=999")).status, 404);
});

test("uploading a new version asks first, then replaces or keeps both", async () => {
	const v1 = await upload("spec.md", "# Spec\n\nlimit 10 A");
	assert.equal(v1.result.status, "added");
	assert.equal((await upload("spec.md", "# Spec\n\nlimit 10 A")).result.status, "exists", "same content: already present, no question");
	assert.deepEqual(await upload("spec.md", "# Spec\n\nlimit 12 A"), { versions: ["spec.md"] });
	const kept = await upload("spec.md", "# Spec\n\nlimit 12 A", "&onUpdate=keep");
	assert.equal(kept.result.doc.title, "spec.md (2)");
	const replaced = await upload("spec.md", "# Spec\n\nlimit 15 A", "&onUpdate=replace");
	assert.equal(replaced.result.doc.title, "spec.md");
	assert.equal(replaced.result.replaced.length, 2, "both earlier versions go");
	const specs = (await (await call("/api/kb/docs")).json()).docs.filter((d: { title: string }) => d.title.startsWith("spec.md"));
	assert.deepEqual(specs.map((d: { id: string }) => d.id), [replaced.result.doc.id]);
});

test("notes: create, refuse duplicates, edit, remove; toggle the knowledge base", async () => {
	const created = await (await post("/api/kb/note", { title: "网页笔记", text: "在网页上记录。", tags: ["web"] })).json();
	assert.equal(created.doc.collection, "wiki");
	const dup = await post("/api/kb/note", { title: "网页笔记", text: "again" });
	assert.equal(dup.status, 400);
	assert.match((await dup.json()).error, /already exists/);

	const read = await (await call(`/api/kb/doc?id=${created.doc.id}`)).json();
	assert.equal(read.text, "# 网页笔记\n\n在网页上记录。", "other apps (pi-learn) get the body alone, without front matter");
	assert.deepEqual(read.note.tags, ["web"]);
	assert.match(read.raw, /^---\ntitle: "网页笔记"/, "the whole file, for editing");
	await post("/api/kb/note", { id: created.doc.id, text: read.raw.replace("在网页上记录。", "改过的内容。") });
	assert.equal((await (await call(`/api/kb/search?q=${encodeURIComponent("改过的内容")}&scope=wiki`)).json()).hits.length, 1);
	assert.match(readFileSync(join(root, "wiki", "log.md"), "utf8"), /edited \[\[网页笔记\]\]/);

	await post("/api/kb/remove", { id: created.doc.id });
	assert.equal((await (await call("/api/kb/docs")).json()).docs.filter((d: { collection: string }) => d.collection === "wiki").length, 0);

	assert.deepEqual(await (await post("/api/kb/enabled", { enabled: false })).json(), { enabled: false });
	assert.equal((await (await call("/api/kb/status")).json()).enabled, false);
	assert.equal((await post("/api/kb/enabled", { enabled: "yes" })).status, 400);
	assert.equal((await call("/api/kb/status", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 404);
});

test("semantic settings: read without the key, switch provider, validate, clear a failed install", async () => {
	const initial = await (await call("/api/kb/semantic")).json();
	assert.equal(initial.provider, "off");
	assert.equal(initial.api.keySaved, false);
	assert.equal(initial.local.installed, false);
	assert.equal(initial.local.bytes, 0);

	// A local server needs no key; the index fails to reach it, which is fine here.
	const baseUrl = "http://127.0.0.1:9/v1";
	const on = await (await post("/api/kb/semantic", { provider: "api", api: { baseUrl, model: "m1", apiKey: " sk-secret " } })).json();
	assert.equal(on.provider, "api");
	const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8")).semantic;
	assert.deepEqual(saved.api, { baseUrl, model: "m1", apiKey: "sk-secret" });
	const read = await (await call("/api/kb/semantic")).text();
	assert.doesNotMatch(read, /sk-secret/, "the stored key never goes back to the page");
	assert.equal(JSON.parse(read).api.keySaved, true);
	assert.equal((await (await call("/api/kb/status")).json()).semantic.provider, "api");

	await post("/api/kb/semantic", { provider: "api", api: { baseUrl, model: "m2", apiKey: "" } });
	assert.equal(kb.config.semantic.api.apiKey, "sk-secret", "an empty key field keeps the saved key");
	assert.equal(kb.config.semantic.api.model, "m2");
	await post("/api/kb/semantic", { provider: "api", api: { baseUrl, model: "m2", clearKey: true } });
	assert.equal(kb.config.semantic.api.apiKey, undefined);

	assert.equal((await post("/api/kb/semantic", { provider: "api", api: { baseUrl: "file:///etc", model: "m" } })).status, 400);
	assert.equal((await post("/api/kb/semantic", { provider: "api", api: { baseUrl: "not a url", model: "m" } })).status, 400);
	assert.equal((await post("/api/kb/semantic", { provider: "cloud" })).status, 400);
	assert.equal(kb.config.semantic.api.baseUrl, baseUrl, "rejected changes are not saved");

	const local = await (await post("/api/kb/semantic", { provider: "local", local: { npmRegistry: "https://registry.npmmirror.com", hfEndpoint: "" } })).json();
	assert.equal(localCalls, 1, "local goes through the same install path as /kb semantic local");
	assert.equal(kb.config.semantic.local.npmRegistry, "https://registry.npmmirror.com", "saved before installing, which uses it");
	assert.equal(kb.config.semantic.local.hfEndpoint, undefined);
	assert.equal(local.provider, "api", "the provider changes only once the install finishes (this fake one never does)");

	installError = "npm install exited with code 1";
	assert.equal((await (await call("/api/kb/status")).json()).semantic.installError, installError);
	await post("/api/kb/semantic", { provider: "off" });
	assert.equal(kb.config.semantic.provider, "off");
	assert.equal(installError, undefined, "choosing something else drops the old install failure");
	assert.deepEqual(await (await post("/api/kb/semantic/remove", {})).json(), { freed: 0 });
});

test("OCR settings: read, validate, save and use for the next import", async () => {
	assert.deepEqual(await (await call("/api/kb/ocr")).json(), { language: "eng+chi_sim", serverUrl: "" });
	const saved = await (await post("/api/kb/ocr", { language: "eng+chi_tra", serverUrl: " http://localhost:8828/ocr " })).json();
	assert.deepEqual(saved, { language: "eng+chi_tra", serverUrl: "http://localhost:8828/ocr" });
	const options = (kb.converter as unknown as { options: { ocrLanguage: string; ocrServerUrl?: string } }).options;
	assert.equal(options.ocrLanguage, "eng+chi_tra", "no restart needed");
	assert.equal(options.ocrServerUrl, "http://localhost:8828/ocr");
	assert.equal((await post("/api/kb/ocr", { language: "eng; rm -rf /" })).status, 400);
	assert.equal((await post("/api/kb/ocr", { language: "eng", serverUrl: "ftp://x" })).status, 400);
	await post("/api/kb/ocr", { language: "eng+chi_sim", serverUrl: "" });
	assert.equal(kb.config.ocrServerUrl, undefined);
});

test("ask: an empty question is refused, and a missing model is reported by code", async () => {
	assert.equal((await post("/api/kb/ask", { question: " " })).status, 400);
	const res = await post("/api/kb/ask", { question: "XR-100 电压" });
	assert.equal(res.status, 409);
	assert.equal((await res.json()).error, "no_model", "the page words it in its own language");
	assert.deepEqual(await (await call("/api/kb/models")).json(), { models: [] }, "no model list while pi has no session");
});

test("shared token: reuses the pi-sessions token, and the hub stops when the last app leaves", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-agent-"));
	try {
		mkdirSync(join(agentDir, "pi-sessions"), { recursive: true });
		writeFileSync(join(agentDir, "pi-sessions", "token"), "b".repeat(48));
		const own = createHub({ agentDir, port: 0 });
		own.mount(fakeSessions);
		await own.start();
		assert.match(own.url() ?? "", /#token=b{48}$/, "old pi-sessions links keep working");
		assert.equal(readFileSync(join(agentDir, "pi-web", "token"), "utf8"), "b".repeat(48));
		await own.unmount("sessions");
		assert.equal(own.url(), undefined, "server stopped");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("shared hub: a reload (every app leaves while serving) restarts on the same port; a stopped hub stays stopped", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-resume-"));
	try {
		const first = sharedHub(agentDir);
		first.mount(fakeSessions);
		await first.start();
		const port = new URL(first.url() ?? "").port;
		await first.unmount("sessions");

		const second = sharedHub(agentDir);
		assert.notEqual(second, first, "new code gets a new hub");
		second.mount(fakeSessions);
		await second.start(); // joins the start that mount() began
		assert.equal(new URL(second.url() ?? "").port, port, "open pages reconnect to the same address");
		assert.equal((await fetch(`http://127.0.0.1:${port}/sessions/`)).status, 200);

		await second.close(); // /kb web stop
		await second.unmount("sessions");
		const third = sharedHub(agentDir);
		third.mount(fakeSessions);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(third.url(), undefined, "stopping on purpose is remembered");
		await third.unmount("sessions");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
