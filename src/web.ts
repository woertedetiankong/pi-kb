import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type WebApp, type WebBinary, type WebLanguage, type WebRequest, webError } from "./hub.ts";
import type { KnowledgeBase } from "./kb.ts";
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
}

/** The knowledge base page and API, mounted on the pi-web hub at /kb/ and /api/kb/. */
export class KbWebApp implements WebApp {
	readonly id = "kb";
	readonly order = 20;
	readonly title: Record<WebLanguage, string> = { zh: "知识库", en: "Knowledge" };
	readonly languages: WebLanguage[] = ["zh", "en"];
	private readonly host: KbWebHost;
	private readonly pageFile: string;

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
					const semantic = { provider: kb.config.semantic.provider, state, done, total, download: download?.progress, problem };
					return { enabled: this.host.enabled(), root: kb.root, ...stats, semantic };
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
					return { doc, text: doc.collection === "wiki" ? kb.noteText(id) : text };
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
					const body = await req.raw(UPLOAD_LIMIT);
					// Keep the original name: it becomes the document title.
					const dir = mkdtempSync(join(tmpdir(), "pi-kb-upload-"));
					try {
						const file = join(dir, name);
						writeFileSync(file, body);
						const result = await kb.addFile(file, { wiki: req.query.get("note") === "1", source: `upload:${name}` });
						return { result: { ...result, path: name } };
					} finally {
						rmSync(dir, { recursive: true, force: true });
						this.host.changed();
					}
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
				case "POST /sync": {
					const result = kb.syncWiki();
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
