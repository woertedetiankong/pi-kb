import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function kbRoot(): string {
	return process.env.PI_KB_DIR || join(homedir(), ".pi", "kb");
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
