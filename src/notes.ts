/** Wiki note format: a small front matter block followed by a Markdown body. */

export interface NoteMeta {
	title: string;
	tags: string[];
	created: string;
	updated: string;
	/** Project (working directory name) the lesson came from. */
	project?: string;
}

export interface Note {
	meta: NoteMeta;
	body: string;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local date as YYYY-MM-DD (not UTC, which is a day behind in the morning in Asia). */
export function today(date = new Date()): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local date and time as YYYY-MM-DD HH:MM. */
export function now(date = new Date()): string {
	return `${today(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse the subset of YAML front matter pi-kb writes; unknown or hand-written notes still load. */
export function parseNote(raw: string, fallbackTitle: string): Note {
	const text = raw.replace(/\r\n?/g, "\n");
	const match = FRONT_MATTER.exec(text);
	const fields: Record<string, string> = {};
	if (match) {
		for (const line of match[1].split("\n")) {
			const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
			if (kv) fields[kv[1]] = kv[2].trim();
		}
	}
	const body = match ? text.slice(match[0].length) : text;
	const heading = /^#\s+(.+)$/m.exec(body);
	const tags = (fields.tags ?? "")
		.replace(/^\[|\]$/g, "")
		.split(",")
		.map((t) => t.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	return {
		meta: {
			title: unquote(fields.title) || heading?.[1].trim() || fallbackTitle,
			tags,
			created: fields.created ?? "",
			updated: fields.updated ?? "",
			project: unquote(fields.project) || undefined,
		},
		body: body.trim(),
	};
}

function unquote(value: string | undefined): string {
	return (value ?? "").replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
}

const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

export function renderNote({ meta, body }: Note): string {
	const lines = ["---", `title: ${quote(meta.title)}`];
	if (meta.tags.length) lines.push(`tags: [${meta.tags.join(", ")}]`);
	lines.push(`created: ${meta.created}`, `updated: ${meta.updated}`);
	if (meta.project) lines.push(`project: ${quote(meta.project)}`);
	lines.push("---", "");
	const heading = /^#\s+/m.test(body.split("\n", 1)[0]) ? "" : `# ${meta.title}\n\n`;
	return `${lines.join("\n")}\n${heading}${body.trim()}\n`;
}

/** File name for a note title; keeps Chinese and other letters, collapses everything else. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return slug || `note-${today()}`;
}

export function normalizeTags(tags: string[] | undefined): string[] {
	return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase().replace(/[\s,[\]]+/g, "-")).filter(Boolean))];
}

/** Letters and digits only, lowercased: "XR-100 SPI 分频" → "xr100spi分频". */
const bare = (text: string) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * How alike two note titles are, 0 to 1 (Dice coefficient over character pairs), so "XR100 SPI
 * clock divider" is recognised next to "XR-100 SPI divider". Works for Chinese as well; titles in
 * different languages score low, which semantic search covers instead.
 */
export function titleSimilarity(a: string, b: string): number {
	const pairs = (text: string) => {
		const s = bare(text);
		const out = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
		// A one-character title still compares with itself.
		if (s.length === 1) out.add(s);
		return out;
	};
	const [x, y] = [pairs(a), pairs(b)];
	if (!x.size || !y.size) return 0;
	let shared = 0;
	for (const p of x) if (y.has(p)) shared++;
	return (2 * shared) / (x.size + y.size);
}

/** The notes a note links to with [[target]], [[target|label]] or [[target#heading]], in order, once each. */
export function wikiLinks(body: string): string[] {
	const out = new Set<string>();
	for (const m of body.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
		const target = m[1].trim();
		if (target) out.add(target);
	}
	return [...out];
}
