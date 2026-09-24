import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KbConfig {
	/** Whether the knowledge base tools and prompt section are active. */
	enabled: boolean;
	/** Tesseract language codes used for scanned pages and images, e.g. "eng+chi_sim". */
	ocrLanguage: string;
	/** Optional OCR HTTP server (e.g. PaddleOCR) used instead of built-in Tesseract; much better for Chinese scans. */
	ocrServerUrl?: string;
}

const DEFAULTS: KbConfig = { enabled: true, ocrLanguage: "eng+chi_sim" };

export function kbRoot(): string {
	return process.env.PI_KB_DIR || join(homedir(), ".pi", "kb");
}

export function loadConfig(root: string): KbConfig {
	try {
		return { ...DEFAULTS, ...JSON.parse(readFileSync(join(root, "config.json"), "utf8")) };
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveConfig(root: string, config: KbConfig): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}
