const CJK_RUN = /[㐀-鿿豈-﫿]/;

export interface QueryPlan {
	/** Terms the user typed; coverage of these drives ranking. */
	terms: string[];
	/** FTS5 MATCH expression for terms the trigram index can serve (3+ chars), or undefined. */
	match: string | undefined;
	/** Terms shorter than a trigram, matched with LIKE instead. */
	short: string[];
}

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
	const terms = [
		...new Set(
			query
				.toLowerCase()
				.split(/[\s,，。、;；:：!！?？"'“”‘’()（）[\]【】<>《》]+/)
				.map((t) => t.trim())
				.filter(Boolean),
		),
	];
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
export function coverage(plan: QueryPlan, candidate: Candidate): number {
	if (!plan.terms.length) return 0;
	const haystack = `${candidate.title}\n${candidate.heading}\n${candidate.content}`.toLowerCase();
	let total = 0;
	for (const term of plan.terms) {
		if (haystack.includes(term)) {
			total += 1;
			continue;
		}
		const grams = CJK_RUN.test(term) ? trigrams(term) : [];
		if (grams.length) total += grams.filter((g) => haystack.includes(g)).length / grams.length;
	}
	return total / plan.terms.length;
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
