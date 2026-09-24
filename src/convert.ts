import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { LiteParse } from "@llamaindex/liteparse";

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

export class Converter {
	private parser: LiteParse | undefined;
	private readonly options: ConvertOptions;

	constructor(options: ConvertOptions) {
		this.options = options;
	}

	private async liteparse(): Promise<LiteParse> {
		if (!this.parser) {
			if (!this.options.ocrServerUrl) await ensureVerticalModels(this.options.tessdataDir, this.options.ocrLanguage);
			const { LiteParse } = await import("@llamaindex/liteparse");
			this.parser = new LiteParse({
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
			});
		}
		return this.parser;
	}

	async convert(path: string): Promise<Converted> {
		const kind = sourceKind(path);
		if (!kind) throw new Error(`Unsupported file type: ${extname(path) || path}`);
		if (kind === "text") {
			const raw = await readFile(path, "utf8");
			const text = HTML.has(extname(path).toLowerCase()) ? htmlToText(raw) : raw;
			return { kind, pages: [{ page: null, markdown: normalizeText(text) }] };
		}
		const parser = await this.liteparse();
		let result: Awaited<ReturnType<LiteParse["parse"]>>;
		try {
			result = await parser.parse(path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/LibreOffice is not installed/i.test(message)) {
				throw new Error("Office files need LibreOffice. Install it with: brew install --cask libreoffice");
			}
			throw error;
		}
		const pages = result.pages.map((p) => ({ page: kind === "image" ? null : p.pageNum, markdown: normalizeText(p.markdown) }));
		return { kind, pages };
	}

	close(): void {
		this.parser?.close();
		this.parser = undefined;
	}
}
