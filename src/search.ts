const CJK_RUN = /[㐀-鿿豈-﫿]/;

export interface QueryPlan {
	/** Terms the user typed; coverage of these drives ranking. */
	terms: string[];
	/** FTS5 MATCH expression for terms the trigram index can serve (3+ chars), or undefined. */
	match: string | undefined;
	/** Terms shorter than a trigram, matched with LIKE instead. */
	short: string[];
}

const STOP_WORDS = new Set(
	"a an and are as at be but by can could do does did for from had has have how i if in into is it its me my no not of on or our should so that the their them then there these they this to was we were what when where which who why will with would you your".split(
		" ",
	),
);
const CJK_QUESTION = /怎么样|怎么|怎样|如何|什么|为什么|为何|哪些|哪个|是否|能不能|可不能|吗|呢/g;

/**
 * With several terms, keyword hits must contain more than this share of them: with two words,
 * one alone is not enough ("Python 列表排序" must not match any page that mentions Python).
 */
export const MIN_COVERAGE = 0.5;

const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;

function trigrams(term: string): string[] {
	const chars = [...term];
	const out: string[] = [];
	for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(""));
	return out;
}

/**
 * Turn a free-text query into trigram-index lookups. Long Chinese runs
 * ("供电电压范围是多少") rarely appear verbatim, so their trigrams are OR-ed in
 * as well and BM25 rewards chunks sharing more of them.
 */
export function planQuery(query: string): QueryPlan {
	const all = [
		...new Set(
			query
				.toLowerCase()
				// Question words carry no topic; splitting on them also breaks "怎么切换模型" into "切换模型".
				.replace(CJK_QUESTION, " ")
				.split(/[\s,，。、;；:：!！?？"'“”‘’()（）[\]【】<>《》]+/)
				.map((t) => t.trim())
				.filter(Boolean),
		),
	];
	// Drop words like "how" and "the", and single Chinese characters such as 用 or 的, which match
	// nearly every passage; keep them only when nothing else is left.
	const content = all.filter((t) => !STOP_WORDS.has(t) && !(CJK_RUN.test(t) && [...t].length === 1));
	const terms = content.length ? content : all;
	const phrases = new Set<string>();
	const short: string[] = [];
	for (const term of terms) {
		const length = [...term].length;
		if (length < 3) {
			short.push(term);
			continue;
		}
		phrases.add(quote(term));
		if (CJK_RUN.test(term) && length > 4) for (const gram of trigrams(term)) phrases.add(quote(gram));
	}
	return { terms, match: phrases.size ? [...phrases].join(" OR ") : undefined, short };
}

export interface Candidate {
	content: string;
	title: string;
	heading: string;
	/** FTS5 bm25() value: lower is better; 0 when the row came from LIKE. */
	bm25: number;
}

/** Fraction of query terms (or, for long CJK terms, of their trigrams) present in the text. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether text contains a query term. English words must start at a word boundary, and words of
 * one or two letters must be whole words, so "pi" does not match "api" and "compact" still
 * matches "compaction". Chinese has no word boundaries and matches as a substring.
 */
export function containsTerm(text: string, term: string): boolean {
	if (!/^[a-z0-9]/i.test(term) || CJK_RUN.test(term)) return text.includes(term);
	const end = term.length <= 2 ? "(?![a-z0-9])" : "";
	// Plurals: "shortcuts" also matches "shortcut", "matches" also "match".
	const stems = [term, ...(/^[a-z]{4,}es$/i.test(term) ? [term.slice(0, -2)] : []), ...(/^[a-z]{4,}s$/i.test(term) ? [term.slice(0, -1)] : [])];
	return stems.some((stem) => new RegExp(`(?<![a-z0-9])${escapeRegExp(stem)}${end}`, "i").test(text));
}

/** How well a chunk contains each query term, 0..1 per term (long Chinese terms can match partly). */
export function termScores(plan: QueryPlan, candidate: Candidate): number[] {
	const haystack = `${candidate.title}\n${candidate.heading}\n${candidate.content}`.toLowerCase();
	return plan.terms.map((term) => {
		if (containsTerm(haystack, term)) return 1;
		const grams = CJK_RUN.test(term) ? trigrams(term) : [];
		return grams.length ? grams.filter((g) => haystack.includes(g)).length / grams.length : 0;
	});
}

export function coverage(plan: QueryPlan, candidate: Candidate): number {
	if (!plan.terms.length) return 0;
	const scores = termScores(plan, candidate);
	return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

export function score(plan: QueryPlan, candidate: Candidate): number {
	// Coverage dominates; bm25 (negative, unbounded) breaks ties among similar coverage.
	return coverage(plan, candidate) * 10 + Math.min(5, -candidate.bm25) / 5;
}

/** A snippet around the first matching term, about `width` characters long. */
export function snippet(plan: QueryPlan, content: string, width = 360): string {
	const lower = content.toLowerCase();
	const needles = [...plan.terms, ...plan.terms.flatMap((t) => (CJK_RUN.test(t) ? trigrams(t) : []))];
	const positions = needles.map((n) => lower.indexOf(n)).filter((p) => p >= 0);
	const at = positions.length ? Math.min(...positions) : 0;
	const start = Math.max(0, at - Math.floor(width / 3));
	const text = content.slice(start, start + width).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${text}${start + width < content.length ? "…" : ""}`;
}

export interface Fused {
	chunk: number;
	score: number;
	match: "keyword" | "semantic" | "both";
}

/**
 * Reciprocal rank fusion: each list contributes 1/(k + rank). Ranks, not raw scores, are
 * combined, so BM25-style keyword scores and cosine similarities need no calibration.
 * On our evaluation set, plain RRF (k = 60, equal weights) beat weighting keyword hits by
 * coverage, smaller k and heavier semantic weights once exact-term questions were included.
 */
export function fuse(keyword: number[], semantic: number[], k = 60): Fused[] {
	const out = new Map<number, Fused>();
	const add = (list: number[], kind: "keyword" | "semantic") => {
		list.forEach((chunk, rank) => {
			const hit = out.get(chunk);
			const score = 1 / (k + rank + 1);
			if (!hit) out.set(chunk, { chunk, score, match: kind });
			else {
				hit.score += score;
				hit.match = "both";
			}
		});
	};
	add(keyword, "keyword");
	add(semantic, "semantic");
	return [...out.values()].sort((a, b) => b.score - a.score);
}
