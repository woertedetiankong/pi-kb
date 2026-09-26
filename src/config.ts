import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LanguageSetting } from "./i18n.ts";
import { profileFor } from "./semantic/models.ts";

export interface KbConfig {
	/** Whether the knowledge base tools and prompt section are active. */
	enabled: boolean;
	/** Tesseract language codes used for scanned pages and images, e.g. "eng+chi_sim". */
	ocrLanguage: string;
	/** Optional OCR HTTP server (e.g. PaddleOCR) used instead of built-in Tesseract; much better for Chinese scans. */
	ocrServerUrl?: string;
	/** Interface language; "auto" follows PI_KB_LANG or the system language. */
	language: LanguageSetting;
	/** Semantic (vector) search; off by default. */
	semantic: SemanticConfig;
	/**
	 * Folder for the content (documents, notes), e.g. in iCloud or a network drive; unset keeps it
	 * in the default folder. This config, the index and the models always stay on this machine.
	 */
	dataDir?: string;
	/** One-time hints already shown, e.g. "welcome" and "semantic", so they are not repeated. */
	tips?: string[];
}

export interface SemanticConfig {
	provider: "off" | "api" | "local";
	/** Cosine floor for semantic hits. Scales differ by model; unset uses defaultMinScore(). */
	minScore?: number;
	/** OpenAI-compatible embeddings API. Document text is sent to this service. */
	api: {
		baseUrl: string;
		model: string;
		/**
		 * Stored key. PI_KB_EMBEDDING_API_KEY takes precedence, then OPENAI_API_KEY for api.openai.com.
		 * The config file is written with mode 0600.
		 */
		apiKey?: string;
	};
	/** Local model run with transformers.js, installed on demand into <kb>/runtime. */
	local: {
		model: string;
		/** HuggingFace mirror for model downloads, e.g. https://hf-mirror.com */
		hfEndpoint?: string;
		/** npm registry used to install the runtime, e.g. https://registry.npmmirror.com */
		npmRegistry?: string;
	};
}

/** Similarity below which a semantic hit is dropped; measured per model (see semantic/models.ts). */
export function defaultMinScore(model: string): number | undefined {
	return profileFor(model).minScore;
}

export const DEFAULT_SEMANTIC: SemanticConfig = {
	provider: "off",
	api: { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
	// Best of bge-m3, Granite R2 and Qwen3 on our benchmark, Apache 2.0; the ONNX build of Qwen/Qwen3-Embedding-0.6B.
	local: { model: "onnx-community/Qwen3-Embedding-0.6B-ONNX" },
};

const DEFAULTS: KbConfig = { enabled: true, ocrLanguage: "eng+chi_sim", language: "auto", semantic: DEFAULT_SEMANTIC };

export interface KbLocation {
	/** This machine's files: config.json, index, OCR data, local model. */
	localDir: string;
	/** The content: raw/, converted/, docs/, wiki/. */
	dir: string;
	/** env: PI_KB_DIR (both folders, cannot be changed from the page); config: chosen on the page. */
	source: "default" | "config" | "env";
}

export const DEFAULT_DIR = join(homedir(), ".pi", "kb");

/** PI_KB_DIR, else the folder chosen on the page, else ~/.pi/kb. */
export function kbLocation(): KbLocation {
	const env = process.env.PI_KB_DIR?.trim();
	if (env) return { localDir: env, dir: env, source: "env" };
	const dataDir = loadConfig(DEFAULT_DIR).dataDir;
	if (dataDir && isAbsolute(dataDir)) return { localDir: DEFAULT_DIR, dir: dataDir, source: "config" };
	return { localDir: DEFAULT_DIR, dir: DEFAULT_DIR, source: "default" };
}

/** Problems with a chosen folder, explained by the interface in the user's language. */
export type LocationProblem = "location_env" | "location_busy" | "location_relative" | "location_not_writable";
export class LocationError extends Error {
	readonly problem: LocationProblem;
	constructor(problem: LocationProblem, detail?: string) {
		super(detail ? `${problem}: ${detail}` : problem);
		this.problem = problem;
	}
}

/** "~/Dropbox/kb" → absolute path; a relative path would depend on where pi was started. */
export function expandDir(input: string): string {
	const path = input.trim().replace(/^~(?=$|[\\/])/, homedir());
	if (!path || !isAbsolute(path)) throw new LocationError("location_relative");
	return resolve(path);
}

export function checkWritable(dir: string): void {
	const probe = join(dir, `.pi-kb-${process.pid}.probe`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(probe, "");
		rmSync(probe, { force: true });
	} catch (error) {
		throw new LocationError("location_not_writable", (error as NodeJS.ErrnoException).code ?? String(error));
	}
}

/** The content folders, which move with the knowledge base. */
export const CONTENT_DIRS = ["raw", "converted", "docs", "wiki"];

/** Copy the content into `to`, keeping whatever is already there (another computer's copy, say). */
export function copyContent(from: string, to: string): void {
	for (const name of CONTENT_DIRS) {
		if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true, force: false, errorOnExist: false });
	}
}

export function loadConfig(root: string): KbConfig {
	try {
		const saved = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
		const semantic = saved.semantic ?? {};
		return {
			...DEFAULTS,
			...saved,
			semantic: {
				...DEFAULT_SEMANTIC,
				...semantic,
				api: { ...DEFAULT_SEMANTIC.api, ...semantic.api },
				local: { ...DEFAULT_SEMANTIC.local, ...semantic.local },
			},
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveConfig(root: string, config: KbConfig): void {
	mkdirSync(root, { recursive: true });
	// May hold an embeddings API key.
	writeFileSync(join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(join(root, "config.json"), 0o600);
}

/** Changes whenever config.json is written; "" when it does not exist. */
export function configStamp(root: string): string {
	try {
		const info = statSync(join(root, "config.json"));
		return `${info.mtimeMs}:${info.size}`;
	} catch {
		return "";
	}
}
