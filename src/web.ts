import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type WebApp, type WebBinary, type WebLanguage, type WebRequest, webError } from "./hub.ts";
import type { AddResult, KnowledgeBase } from "./kb.ts";
import type { ImportItem, ImportJob, ImportStatus } from "./queue.ts";
import { ask, AskError, listModels, type ModelContext } from "./ask.ts";
import { type KbLocation, LocationError, type SemanticConfig } from "./config.ts";
import { apiKeyEnv, folderSize, localModelDirs, removeLocalModel, runtimeInstalled } from "./semantic/providers.ts";
import { parseNote } from "./notes.ts";
import type { Collection } from "./store.ts";

const UPLOAD_LIMIT = 200 * 1024 * 1024;
const TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
};

export interface KbWebHost {
	kb(): KnowledgeBase;
	enabled(): boolean;
	setEnabled(on: boolean): void;
	/** Something changed on the page; refresh the terminal status bar. */
	changed(): void;
	/** Import in the background, on the same queue as /kb add. */
	enqueue(item: ImportItem): ImportJob;
	importStatus(): ImportStatus & { active: boolean };
	/** Switch to the local model, installing its runtime first when needed (same as /kb semantic local). */
	useLocal(): Promise<boolean>;
	/** The runtime install in progress (last npm output line) or the last failure. */
	localSetup(): { installing?: string; installError?: string };
	/** The user chose something other than the local model: stop reporting a failed install. */
	forgetInstallError(): void;
	/** pi's current model, for answering questions on the page; undefined while pi switches sessions. */
	model(): ModelContext | undefined;
	/** Where the knowledge base is, and how that was decided. */
	location(): KbLocation;
	/** Move the content to `dir` (undefined: the default folder), copying it there unless `copy` is false. */
	relocate(dir: string | undefined, copy: boolean): void;
}

/** An http(s) URL, or undefined when empty; anything else is the caller's mistake. */
function optionalUrl(value: unknown, field: string): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return undefined;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw webError(400, `${field} is not a URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw webError(400, `${field} must be http or https`);
	return text;
}

/** How long a finished upload's results wait for the page to collect them. */
const JOB_KEEP_MS = 10 * 60_000;

/** The knowledge base page and API, mounted on the pi-web hub at /kb/ and /api/kb/. */
export class KbWebApp implements WebApp {
	readonly id = "kb";
	readonly order = 20;
	readonly title: Record<WebLanguage, string> = { zh: "知识库", en: "Knowledge" };
	readonly languages: WebLanguage[] = ["zh", "en"];
	private readonly host: KbWebHost;
	private readonly pageFile: string;
	/** Upload jobs by number, so the page can poll for their results. */
	private readonly jobs = new Map<number, { job: ImportJob; finished: boolean }>();
	private lastJob = 0;

	constructor(host: KbWebHost, pageFile: string) {
		this.host = host;
		this.pageFile = pageFile;
	}

	async page(): Promise<string> {
		return readFileSync(this.pageFile, "utf8");
	}

	async handle(req: WebRequest): Promise<unknown> {
		const kb = this.host.kb();
		const route = `${req.method} ${req.path}`;
		const id = req.query.get("id") ?? "";
		try {
			switch (route) {
				case "GET /status": {
					const stats = kb.store.stats();
					const { state, done, total, download, problem } = kb.indexer.status;
					const semantic = { provider: kb.config.semantic.provider, state, done, total, download: download?.progress, problem, ...this.host.localSetup() };
					const imports = this.host.importStatus();
					const current = imports.current ? basename(imports.current) : undefined;
					return { enabled: this.host.enabled(), root: kb.root, ...stats, semantic, imports: { ...imports, current } };
				}
				case "GET /docs":
					return { docs: kb.store.listDocs() };
				case "GET /search": {
					const q = (req.query.get("q") ?? "").trim();
					const scope = req.query.get("scope");
					const collection: Collection | undefined = scope === "docs" || scope === "wiki" ? scope : undefined;
					return { hits: q ? await kb.find(q, { limit: 30, collection }) : [] };
				}
				case "GET /doc": {
					const { doc, text } = kb.read(id);
					if (doc.collection !== "wiki") return { doc, text };
					// Other apps (pi-learn) read `text` as material, so a note's front matter goes separately;
					// `raw` is the whole file, for editing.
					const raw = kb.noteText(id);
					const { meta, body } = parseNote(raw, doc.title);
					return { doc, text: body, note: meta, raw };
				}
				case "GET /file": {
					const { file, name } = kb.originalFile(id);
					const type = TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
					return { binary: readFileSync(file), type, filename: name, cacheSeconds: 3600 } satisfies WebBinary;
				}
				case "POST /enabled": {
					const body = await req.json();
					if (typeof body.enabled !== "boolean") throw webError(400, "enabled must be true or false");
					this.host.setEnabled(body.enabled);
					return { enabled: this.host.enabled() };
				}
				case "POST /upload": {
					const name = basename(req.query.get("name") ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
					if (!name || name.startsWith(".")) throw webError(400, "missing file name");
					const note = req.query.get("note") === "1";
					const onUpdate = req.query.get("onUpdate");
					const body = await req.raw(UPLOAD_LIMIT);
					// Keep the original name: it becomes the document title. The file stays until the queue is done with it.
					const dir = mkdtempSync(join(tmpdir(), "pi-kb-upload-"));
					let queued = false;
					try {
						const file = join(dir, name);
						writeFileSync(file, body);
						const previous = note ? [] : kb.previousVersions(file, { name });
						// A new version of an imported document: let the page ask whether to replace it.
						if (previous.length && onUpdate !== "replace" && onUpdate !== "keep") return { versions: previous.map((d) => d.title) };
						const replace = onUpdate === "replace" ? previous.map((d) => d.id) : undefined;
						const job = this.host.enqueue({ path: file, wiki: note, source: `upload:${name}`, replace });
						queued = true;
						const id = ++this.lastJob;
						const entry = { job, finished: false };
						this.jobs.set(id, entry);
						void job.done.then(() => {
							entry.finished = true;
							rmSync(dir, { recursive: true, force: true });
							this.host.changed();
							setTimeout(() => this.jobs.delete(id), JOB_KEEP_MS).unref();
						});
						return { job: id };
					} finally {
						if (!queued) rmSync(dir, { recursive: true, force: true });
					}
				}
				case "GET /import": {
					const entry = this.jobs.get(Number(req.query.get("job")));
					if (!entry) throw webError(404, "unknown import");
					if (!entry.finished) return { done: false };
					this.jobs.delete(Number(req.query.get("job")));
					const results: AddResult[] = entry.job.results.map((r) => ({ ...r, path: basename(r.path) }));
					return { done: true, results };
				}
				case "POST /remove": {
					const body = await req.json();
					const doc = kb.remove(String(body.id ?? ""));
					this.host.changed();
					return { removed: doc.id };
				}
				case "POST /note": {
					const body = await req.json();
					const text = typeof body.text === "string" ? body.text : "";
					let doc;
					if (body.id) doc = kb.editNote(String(body.id), text);
					else {
						const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
						doc = kb.writeNote(kb.prepareNote({ title: String(body.title ?? ""), content: text, tags }));
					}
					this.host.changed();
					return { doc };
				}
				case "GET /semantic": {
					const cfg = kb.config.semantic;
					const { error, problem } = kb.indexer.status;
					return {
						provider: cfg.provider,
						// Never send the stored key back; say only where a key comes from.
						api: { baseUrl: cfg.api.baseUrl, model: cfg.api.model, keySaved: Boolean(cfg.api.apiKey), keyEnv: apiKeyEnv(cfg.api.baseUrl) },
						local: {
							model: cfg.local.model,
							hfEndpoint: cfg.local.hfEndpoint ?? "",
							npmRegistry: cfg.local.npmRegistry ?? "",
							installed: runtimeInstalled(join(kb.localDir, "runtime")),
							bytes: localModelDirs(kb.localDir).reduce((n, dir) => n + folderSize(dir), 0),
						},
						error,
						problem,
						...this.host.localSetup(),
					};
				}
				case "POST /semantic": {
					const body = await req.json();
					if (!["off", "api", "local"].includes(body.provider)) throw webError(400, "provider must be off, api or local");
					const cfg = kb.config.semantic;
					const next: SemanticConfig = { ...cfg, api: { ...cfg.api }, local: { ...cfg.local } };
					if (body.api) {
						next.api.baseUrl = optionalUrl(body.api.baseUrl, "API base URL") ?? cfg.api.baseUrl;
						next.api.model = String(body.api.model ?? "").trim() || cfg.api.model;
						const key = typeof body.api.apiKey === "string" ? body.api.apiKey.trim() : "";
						if (key) next.api.apiKey = key;
						else if (body.api.clearKey === true) delete next.api.apiKey;
					}
					if (body.local) {
						next.local.hfEndpoint = optionalUrl(body.local.hfEndpoint, "Hugging Face mirror");
						next.local.npmRegistry = optionalUrl(body.local.npmRegistry, "npm registry");
					}
					if (body.provider === "local") {
						// Save the download sources first: the install uses the npm registry.
						kb.updateConfig({ semantic: next });
						void this.host.useLocal();
					} else {
						kb.updateConfig({ semantic: { ...next, provider: body.provider } });
						this.host.forgetInstallError();
					}
					this.host.changed();
					return { provider: kb.config.semantic.provider, ...this.host.localSetup() };
				}
				case "POST /semantic/remove": {
					if (this.host.localSetup().installing) throw webError(409, "the local model runtime is being installed");
					// Stop using the model before its files go away.
					if (kb.config.semantic.provider === "local") kb.updateConfig({ semantic: { ...kb.config.semantic, provider: "off" } });
					this.host.changed();
					return { freed: removeLocalModel(kb.localDir) };
				}
				case "GET /models":
					return listModels(this.host.model());
				case "POST /ask": {
					const body = await req.json();
					const question = typeof body.question === "string" ? body.question.trim() : "";
					if (!question) throw webError(400, "question is empty");
					const model = typeof body.model === "string" && body.model ? body.model : undefined;
					try {
						return await ask(kb, this.host.model(), question, req.signal, model);
					} catch (error) {
						// The page words these in its own language: "<problem>" or "<problem>: <detail>".
						if (error instanceof AskError) throw webError(error.status, error.message === error.problem ? error.problem : `${error.problem}: ${error.message}`);
						throw error;
					}
				}
				case "GET /location": {
					const { dir, localDir, source } = this.host.location();
					return { dir, localDir, source, docs: kb.store.stats().docs, notes: kb.store.stats().wiki };
				}
				case "POST /location": {
					const body = await req.json();
					const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir : undefined;
					try {
						this.host.relocate(dir, body.copy !== false);
					} catch (error) {
						// The page words these in its own language.
						if (error instanceof LocationError) throw webError(error.problem === "location_busy" || error.problem === "location_env" ? 409 : 400, error.message);
						throw error;
					}
					this.host.changed();
					const now = this.host.location();
					const fresh = this.host.kb().store.stats();
					return { dir: now.dir, localDir: now.localDir, source: now.source, docs: fresh.docs, notes: fresh.wiki };
				}
				case "GET /ocr":
					return { language: kb.config.ocrLanguage, serverUrl: kb.config.ocrServerUrl ?? "" };
				case "POST /ocr": {
					const body = await req.json();
					const language = typeof body.language === "string" ? body.language.trim() : "";
					// Tesseract codes joined with "+", e.g. eng+chi_sim.
					if (!/^[A-Za-z_]+(\+[A-Za-z_]+)*$/.test(language)) throw webError(400, "OCR language must look like eng+chi_sim");
					kb.updateConfig({ ocrLanguage: language, ocrServerUrl: optionalUrl(body.serverUrl, "OCR server") });
					return { language: kb.config.ocrLanguage, serverUrl: kb.config.ocrServerUrl ?? "" };
				}
				case "POST /sync": {
					const result = kb.sync();
					this.host.changed();
					return result;
				}
				default:
					throw webError(404, "not found");
			}
		} catch (error) {
			if (typeof (error as { status?: unknown }).status === "number") throw error;
			// Knowledge base errors are the caller's fault (unknown id, duplicate title, empty note...).
			throw webError(400, error instanceof Error ? error.message : String(error));
		}
	}
}
