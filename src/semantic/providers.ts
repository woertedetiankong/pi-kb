import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SemanticConfig } from "../config.ts";
import { type ModelProfile, profileFor } from "./models.ts";

export type EmbedKind = "query" | "passage";

export interface EmbeddingProvider {
	/** Identifies the vector space; stored vectors with another key are stale and get rebuilt. */
	readonly key: string;
	embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Setup problems the interface explains in the user's language. */
export type SemanticProblem = "no_api_key" | "runtime_missing";

export class SemanticError extends Error {
	readonly problem: SemanticProblem;
	constructor(problem: SemanticProblem, message: string) {
		super(message);
		this.problem = problem;
	}
}

/** Unit length, so cosine similarity is a dot product. */
export function normalize(values: ArrayLike<number>): Float32Array {
	const out = Float32Array.from(values);
	let sum = 0;
	for (const x of out) sum += x * x;
	const norm = Math.sqrt(sum) || 1;
	for (let i = 0; i < out.length; i++) out[i] /= norm;
	return out;
}

export const API_KEY_ENV = "PI_KB_EMBEDDING_API_KEY";

/** Any OpenAI-compatible /embeddings endpoint (OpenAI, SiliconFlow, Ollama, vLLM, ...). */
export class ApiProvider implements EmbeddingProvider {
	readonly key: string;
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly apiKey?: string;
	private readonly profile: ModelProfile;

	constructor(options: SemanticConfig["api"]) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.model = options.model;
		this.apiKey = options.apiKey;
		this.profile = profileFor(options.model);
		this.key = `api:${this.baseUrl}|${this.model}`;
	}

	async embed(inputs: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
		// Instruction-tuned models (Qwen3) expect an instruction on queries, not on documents.
		const texts = kind === "query" ? inputs.map((t) => this.profile.queryPrefix + t) : inputs;
		// OpenAI users usually have OPENAI_API_KEY set already.
		const openai = /^https:\/\/api\.openai\.com\//.test(`${this.baseUrl}/`);
		const key = process.env[API_KEY_ENV] || this.apiKey || (openai ? process.env.OPENAI_API_KEY : undefined);
		// Local servers such as Ollama need no key.
		const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(this.baseUrl);
		if (!key && !local) throw new SemanticError("no_api_key", `No API key: set ${API_KEY_ENV} or run /kb semantic api`);
		for (let attempt = 0; ; attempt++) {
			const response = await fetch(`${this.baseUrl}/embeddings`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify({ model: this.model, input: texts, encoding_format: "float" }),
				signal,
			});
			// Rate limits and server hiccups are common on free tiers: back off and retry a few times.
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
				continue;
			}
			if (!response.ok) {
				const detail = (await response.text().catch(() => "")).slice(0, 300);
				throw new Error(`Embeddings API ${response.status}: ${detail}`);
			}
			const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
			const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
			if (data.length !== texts.length) throw new Error(`Embeddings API returned ${data.length} vectors for ${texts.length} texts`);
			return data.map((d) => normalize(d.embedding));
		}
	}
}

/** The transformers.js version installed on demand; pinned so every machine gets the same runtime. */
export const RUNTIME_PACKAGE = "@huggingface/transformers@4.3.0";

export function runtimeInstalled(runtimeDir: string): boolean {
	return existsSync(join(runtimeDir, "node_modules", "@huggingface", "transformers", "package.json"));
}

/** Folders the local model option downloads into the knowledge base (runtime ~500 MB, model ~610 MB). */
export function localModelDirs(root: string): string[] {
	return [join(root, "runtime"), join(root, "models")];
}

/** Bytes used by a folder, not following symlinks; 0 when it does not exist. */
export function folderSize(path: string): number {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(path);
	} catch {
		return 0;
	}
	if (!info.isDirectory()) return info.size;
	return readdirSync(path).reduce((n, entry) => n + folderSize(join(path, entry)), 0);
}

/** Delete the local runtime and model files; returns the bytes freed. Documents, notes and vectors stay. */
export function removeLocalModel(root: string): number {
	let freed = 0;
	for (const dir of localModelDirs(root)) {
		freed += folderSize(dir);
		rmSync(dir, { recursive: true, force: true });
	}
	return freed;
}

/**
 * Install transformers.js (and its ONNX runtime, ~300 MB) into runtimeDir with npm.
 * Kept out of pi-kb's own dependencies so people who never use a local model don't download it.
 */
export function installRuntime(runtimeDir: string, registry: string | undefined, onOutput?: (line: string) => void, signal?: AbortSignal): Promise<void> {
	mkdirSync(runtimeDir, { recursive: true });
	if (!existsSync(join(runtimeDir, "package.json"))) writeFileSync(join(runtimeDir, "package.json"), '{ "name": "pi-kb-runtime", "private": true }\n');
	const args = ["install", RUNTIME_PACKAGE, "--no-audit", "--no-fund", "--loglevel=error", ...(registry ? [`--registry=${registry}`] : [])];
	return new Promise((resolve, reject) => {
		const child = spawn("npm", args, { cwd: runtimeDir, shell: process.platform === "win32", signal });
		const forward = (chunk: Buffer) => {
			for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onOutput?.(line.trim());
		};
		child.stdout.on("data", forward);
		child.stderr.on("data", forward);
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
	});
}

export interface DownloadProgress {
	file: string;
	/** 0-100 */
	progress: number;
}

type Extractor = (texts: string[], options: { pooling: ModelProfile["pooling"]; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/** A local sentence-embedding model run with transformers.js (ONNX). Downloads the model on first use. */
export class LocalProvider implements EmbeddingProvider {
	readonly key: string;
	private readonly options: SemanticConfig["local"] & { runtimeDir: string; cacheDir: string };
	private readonly profile: ModelProfile;
	private extractor?: Promise<Extractor>;
	/** Download progress while the model loads; undefined once it is ready. */
	onDownload?: (progress: DownloadProgress | undefined) => void;

	constructor(options: SemanticConfig["local"] & { runtimeDir: string; cacheDir: string }) {
		this.options = options;
		this.profile = profileFor(options.model);
		// The pooling is part of the vector space: vectors made another way must be rebuilt.
		this.key = `local:${options.model}#${this.profile.pooling}`;
	}

	private load(): Promise<Extractor> {
		this.extractor ??= (async () => {
			const { runtimeDir, cacheDir, model, hfEndpoint } = this.options;
			if (!runtimeInstalled(runtimeDir)) throw new SemanticError("runtime_missing", "The local model runtime is not installed; run /kb semantic local");
			const entry = createRequire(join(runtimeDir, "package.json")).resolve("@huggingface/transformers");
			const tf = await import(pathToFileURL(entry).href);
			tf.env.cacheDir = cacheDir;
			tf.env.allowLocalModels = false;
			if (hfEndpoint) tf.env.remoteHost = hfEndpoint.replace(/\/?$/, "/");
			const extractor = (await tf.pipeline("feature-extraction", model, {
				dtype: "q8",
				...(this.profile.revision ? { revision: this.profile.revision } : {}),
				progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
					if (event.status === "progress" && event.file) this.onDownload?.({ file: event.file, progress: event.progress ?? 0 });
				},
			})) as Extractor;
			this.onDownload?.(undefined);
			return extractor;
		})();
		// A failed load (offline, missing runtime) may succeed later.
		this.extractor.catch(() => {
			this.extractor = undefined;
		});
		return this.extractor;
	}

	async embed(inputs: string[], kind: EmbedKind): Promise<Float32Array[]> {
		const extractor = await this.load();
		const texts = kind === "query" ? inputs.map((t) => this.profile.queryPrefix + t) : inputs;
		const output = await extractor(texts, { pooling: this.profile.pooling, normalize: true });
		return output.tolist().map((v) => normalize(v));
	}
}

export function createProvider(config: SemanticConfig, root: string): EmbeddingProvider | undefined {
	if (config.provider === "api") return new ApiProvider(config.api);
	if (config.provider === "local") {
		return new LocalProvider({ ...config.local, runtimeDir: join(root, "runtime"), cacheDir: join(root, "models") });
	}
	return undefined;
}
