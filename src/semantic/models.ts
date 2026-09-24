/**
 * How to use each embedding model we know. Shared by the local and API providers so that,
 * for example, Qwen3 queries get the same instruction (and the same similarity floor)
 * whether the model runs on this machine or behind an API.
 */
export interface ModelProfile {
	/** Local (transformers.js) pooling; APIs pool on their side. */
	pooling: "cls" | "mean" | "last_token";
	/** Prepended to queries only; documents are embedded as they are. */
	queryPrefix: string;
	/**
	 * Cosine floor for semantic hits, measured on our benchmark (502 chunks of English docs and
	 * Chinese notes, 23 related and 8 unrelated questions). Undefined: no reliable floor known.
	 */
	minScore?: number;
	/** Hugging Face commit to download, so every machine gets the files we measured. */
	revision?: string;
}

const QWEN3_INSTRUCTION = "Instruct: Given a question, retrieve passages from technical documents and notes that answer it\nQuery:";

const PROFILES: { match: RegExp; profile: ModelProfile }[] = [
	{
		// Best of those tested: related questions' best hit scored >= 0.46, unrelated <= 0.392.
		match: /qwen3-embedding-0\.6b/i,
		profile: { pooling: "last_token", queryPrefix: QWEN3_INSTRUCTION, minScore: 0.43 },
	},
	{ match: /qwen3-embedding/i, profile: { pooling: "last_token", queryPrefix: QWEN3_INSTRUCTION } },
	// Official CLS vectors: related >= 0.53, unrelated <= 0.49.
	{ match: /bge-m3/i, profile: { pooling: "cls", queryPrefix: "", minScore: 0.51 } },
];

/** Exact local model ids pinned to the commit we benchmarked. */
const REVISIONS: Record<string, string> = {
	"onnx-community/Qwen3-Embedding-0.6B-ONNX": "c25a394dd583836952667c12f008335071b3f43d",
};

export function profileFor(model: string): ModelProfile {
	const profile = PROFILES.find((p) => p.match.test(model))?.profile ?? { pooling: "mean", queryPrefix: "" };
	return { ...profile, revision: REVISIONS[model] };
}
