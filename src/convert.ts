import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One page of converted Markdown. `page` is the 1-based physical page, or null for unpaged sources. */
export interface ConvertedPage {
	page: number | null;
	markdown: string;
}

export type SourceKind = "pdf" | "office" | "image" | "text";

export interface Converted {
	kind: SourceKind;
	pages: ConvertedPage[];
}

const PDF = new Set([".pdf"]);
// Converted to PDF by LiteParse through LibreOffice.
const OFFICE = new Set([".doc", ".docx", ".odt", ".rtf", ".ppt", ".pptx", ".odp", ".xls", ".xlsx", ".ods"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif"]);
const HTML = new Set([".html", ".htm"]);
const TEXT = new Set([
	".md", ".markdown", ".mdx", ".txt", ".rst", ".org", ".adoc", ".tex", ".log",
	".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".xml",
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java", ".kt", ".swift",
	".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".sql", ".lua",
]);

/** How to install LibreOffice on this system. */
export function libreOfficeInstall(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "brew install --cask libreoffice";
	if (platform === "win32") return "winget install TheDocumentFoundation.LibreOffice";
	return "sudo apt install libreoffice (or your distribution's package manager)";
}

export function sourceKind(path: string): SourceKind | undefined {
	const ext = extname(path).toLowerCase();
	if (PDF.has(ext)) return "pdf";
	if (OFFICE.has(ext)) return "office";
	if (IMAGE.has(ext)) return "image";
	if (TEXT.has(ext) || HTML.has(ext)) return "text";
	return undefined;
}

export function isMarkdown(path: string): boolean {
	return [".md", ".markdown", ".mdx"].includes(extname(path).toLowerCase());
}

const CJK = "\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
const CJK_GAP = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");

/**
 * Make extracted text searchable: OCR puts spaces between Chinese characters and
 * the Markdown renderer escapes identifiers such as CTRL\_REG. Both would defeat
 * substring search, so they are undone here.
 */
export function normalizeText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1")
		.replace(CJK_GAP, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

export interface ConvertOptions {
	ocrLanguage: string;
	/** Where Tesseract language data is cached; LiteParse downloads missing languages here. */
	tessdataDir: string;
	ocrServerUrl?: string;
}

const TESSDATA_URL = "https://github.com/tesseract-ocr/tessdata_best/raw/main";
/** Languages whose models load a vertical-text companion that LiteParse does not download itself. */
const VERTICAL = new Set(["chi_sim", "chi_tra", "jpn", "kor"]);

/**
 * Fetch `<lang>_vert.traineddata` for CJK languages. Without it Tesseract prints
 * a load error straight to the terminal on every OCR run. Failures are ignored:
 * OCR still works without the vertical model.
 */
async function ensureVerticalModels(dir: string, language: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	for (const lang of language.split("+")) {
		if (!VERTICAL.has(lang)) continue;
		const file = join(dir, `${lang}_vert.traineddata`);
		if (existsSync(file)) continue;
		try {
			const response = await fetch(`${TESSDATA_URL}/${lang}_vert.traineddata`);
			if (!response.ok) continue;
			writeFileSync(`${file}.tmp`, Buffer.from(await response.arrayBuffer()));
			renameSync(`${file}.tmp`, file);
		} catch {
			// Offline or blocked: continue without the vertical model.
		}
	}
}

/** A page rendered to an image. */
export interface PageImage {
	page: number;
	png: Buffer;
}

/** What the worker process sends back: converted pages, or rendered ones when asked for a screenshot. */
type WorkerOk = { ok: true; pages?: { pageNum: number; markdown: string }[]; images?: { pageNum: number; png: string }[] };
type WorkerReply = WorkerOk | { ok: false; error: string };

/** Resolution for rendered pages: a Letter page becomes 1275×1650, legible for small print in diagrams. */
const RENDER_DPI = 150;

const WORKER = fileURLToPath(new URL("./parse-worker.mjs", import.meta.url));

/**
 * Run one LiteParse conversion in a child process. Tesseract prints debug lines straight to
 * the terminal, which would scribble over pi's interface, so the child's stdout is dropped and
 * stderr kept only for error messages. Aborting kills the child, which also stops a long PDF
 * part-way (LiteParse itself cannot be interrupted).
 */
function runParse(
	path: string,
	config: Record<string, unknown>,
	children: Set<ChildProcess>,
	signal?: AbortSignal,
	screenshot?: number[],
) {
	signal?.throwIfAborted();
	return new Promise<WorkerOk>((resolve, reject) => {
		const child = spawn(process.execPath, [WORKER], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
		children.add(child);
		let settled = false;
		let stderr = "";
		const finish = (error?: Error, reply?: WorkerOk) => {
			if (settled) return;
			settled = true;
			children.delete(child);
			signal?.removeEventListener("abort", abort);
			child.kill();
			if (error) reject(error);
			else resolve(reply!);
		};
		const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("conversion aborted"));
		signal?.addEventListener("abort", abort, { once: true });
		child.stderr?.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-3000)));
		child.on("error", (error) => finish(error));
		child.on("exit", (code) => finish(new Error(`parser process exited (${code})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)));
		child.on("message", (reply: WorkerReply) => (reply.ok ? finish(undefined, reply) : finish(new Error(reply.error))));
		child.send({ path, config, screenshot });
	});
}

export class Converter {
	private options: ConvertOptions;
	private readonly children = new Set<ChildProcess>();
	private verticalReady?: Promise<void>;

	constructor(options: ConvertOptions) {
		this.options = options;
	}

	private get parseConfig(): Record<string, unknown> {
		return {
			outputFormat: "markdown",
			ocrEnabled: true,
			ocrLanguage: this.options.ocrLanguage,
			tessdataPath: this.options.tessdataDir,
			ocrServerUrl: this.options.ocrServerUrl,
			// Keep native text when OCR fails (for example, language data cannot be downloaded).
			ocrFailureFatal: false,
			continueOnPageError: true,
			maxPages: 5000,
			quiet: true,
		};
	}

	/**
	 * OCR languages whose Tesseract data is not on disk yet. LiteParse downloads them from GitHub on
	 * first use (about 13-15 MB each); empty when an OCR server is set.
	 */
	missingOcrData(): string[] {
		if (this.options.ocrServerUrl) return [];
		return this.options.ocrLanguage
			.split("+")
			.filter((lang) => lang && !existsSync(join(this.options.tessdataDir, `${lang}.traineddata`)));
	}

	/** Whether converting this file may run OCR (images, and pictures inside PDFs). */
	static mayOcr(path: string): boolean {
		const kind = sourceKind(path);
		return kind === "image" || kind === "pdf";
	}

	/** Use other OCR settings from the next conversion on; running ones finish with the old settings. */
	setOcr(ocr: Pick<ConvertOptions, "ocrLanguage" | "ocrServerUrl">): void {
		if (ocr.ocrLanguage !== this.options.ocrLanguage) this.verticalReady = undefined;
		this.options = { ...this.options, ...ocr };
	}

	/** Convert a file to Markdown pages. Aborting stops the conversion and rejects. */
	async convert(path: string, signal?: AbortSignal): Promise<Converted> {
		const kind = sourceKind(path);
		if (!kind) throw new Error(`Unsupported file type: ${extname(path) || path}`);
		if (kind === "text") {
			const raw = await readFile(path, "utf8");
			const text = HTML.has(extname(path).toLowerCase()) ? htmlToText(raw) : raw;
			return { kind, pages: [{ page: null, markdown: normalizeText(text) }] };
		}
		if (!this.options.ocrServerUrl) {
			this.verticalReady ??= ensureVerticalModels(this.options.tessdataDir, this.options.ocrLanguage);
			await this.verticalReady;
		}
		const result = await this.run(path, this.parseConfig, signal);
		const pages = (result.pages ?? []).map((p) => ({ page: kind === "image" ? null : p.pageNum, markdown: normalizeText(p.markdown) }));
		return { kind, pages };
	}

	/** Render pages of a PDF, Office file or image to PNG (an image has the one page 1). No OCR runs. */
	async render(path: string, pages: number[], signal?: AbortSignal): Promise<PageImage[]> {
		const kind = sourceKind(path);
		if (!kind || kind === "text") throw new Error(`Cannot render ${extname(path) || path} files as pages`);
		const result = await this.run(path, { quiet: true, dpi: RENDER_DPI }, signal, pages);
		return (result.images ?? []).map((i) => ({ page: i.pageNum, png: Buffer.from(i.png, "base64") }));
	}

	private async run(path: string, config: Record<string, unknown>, signal?: AbortSignal, screenshot?: number[]): Promise<WorkerOk> {
		try {
			return await runParse(path, config, this.children, signal, screenshot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/LibreOffice is not installed/i.test(message)) {
				throw new Error(`Office files need LibreOffice. Install it with: ${libreOfficeInstall()}`);
			}
			throw error;
		}
	}

	/** Stop every running conversion. */
	close(): void {
		for (const child of this.children) child.kill();
		this.children.clear();
	}
}
