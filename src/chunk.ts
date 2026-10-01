import type { ConvertedPage } from "./convert.ts";

export interface Chunk {
	page: number | null;
	/** Nearest Markdown heading above the chunk, carried across page breaks. */
	heading: string;
	content: string;
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*$/;

/**
 * Split pages into search chunks of roughly `maxChars`, never crossing a page
 * (so every hit keeps an exact page citation) and starting a new chunk at each heading.
 */
export function chunkPages(pages: ConvertedPage[], maxChars = 1200): Chunk[] {
	const chunks: Chunk[] = [];
	let heading = "";
	for (const { page: { page, markdown: text }, carry } of tableCarries(pages)) {
		// The carried header goes into the chunk holding the table's first row, after splitting, so the
		// page splits as before (existing chunks, and their vectors, stay; see KnowledgeBase.rechunk).
		const from = chunks.length;
		// "[figure]" (see markFigures) is for readers; searching "figure" should not find every picture.
		const markdown = text.replace(/^\[figure\]$/gm, "");
		let buffer: string[] = [];
		let size = 0;
		let bufferHeading = heading;
		const flush = () => {
			const content = buffer.join("\n\n").trim();
			if (content) chunks.push({ page, heading: bufferHeading, content });
			buffer = [];
			size = 0;
			bufferHeading = heading;
		};
		for (const block of markdown.split(/\n{2,}/)) {
			const text = block.trim();
			if (!text) continue;
			const match = HEADING.exec(text.split("\n", 1)[0]);
			if (match) {
				flush();
				heading = match[1];
				bufferHeading = heading;
			}
			for (const piece of splitLong(text, maxChars)) {
				if (size > 0 && size + piece.length > maxChars) flush();
				buffer.push(piece);
				size += piece.length + 2;
			}
		}
		flush();
		const into = carry && chunks.slice(from).find((c) => c.content.includes(carry.from));
		if (carry && into) into.content = into.content.replace(carry.from, carry.to);
	}
	return chunks;
}

function splitLong(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const pieces: string[] = [];
	let current = "";
	// Prefer line boundaries (keeps table rows whole), then hard-split very long lines.
	for (const line of text.split("\n")) {
		if (current && current.length + line.length + 1 > maxChars) {
			pieces.push(current);
			current = "";
		}
		if (line.length > maxChars) {
			for (let i = 0; i < line.length; i += maxChars) pieces.push(line.slice(i, i + maxChars));
			continue;
		}
		current = current ? `${current}\n${line}` : line;
	}
	if (current) pieces.push(current);
	return pieces;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const cellsOf = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().toLowerCase());
const cells = (row: string) => cellsOf(row).length;
/** Two rows that are the same header written slightly differently ("Direct MUX" / "MUX"): half their cells or more agree. */
const sameHeader = (a: string, b: string) => {
	const [x, y] = [cellsOf(a), cellsOf(b)];
	return x.filter((c, i) => c && c === y[i]).length * 2 >= x.length;
};
/**
 * Whether a table's first row can be a real header: two columns or more, no empty cell (a garbled
 * header) and no cell that is only a number. A table of contents' first row ("9.3.3.1 | Allocate … | 545") is data the reader took for one.
 */
const headerLike = (row: string) => cells(row) >= 2 && !cellsOf(row).some((c) => !c || /^[\d.,\-–]+$/.test(c));
/** A row that reads as data: a cell with a digit, or an empty or "-" one. A row of words only is taken for the new table's own header. */
const dataLike = (row: string) => cellsOf(row).some((c) => /\d/.test(c) || c === "" || c === "-");

/**
 * Bump when chunking changes what is indexed, so existing knowledge bases index their documents
 * again (see KnowledgeBase.rechunk). 2: table headers carried across pages.
 */
export const CHUNKS_VERSION = 2;

/**
 * A table that runs on to the next page loses its header there: the PDF reader makes the first
 * row on the new page the header, so a model reading only that page cannot tell the columns apart.
 * Put the previous page's header back on top. Only when the previous page ends with the table, the
 * next one opens with a table (after at most a running header, no heading) with as many columns,
 * that table does not repeat the header already, and its first row reads as data, not as a header of its own.
 */
export function carryTableHeaders(pages: ConvertedPage[]): ConvertedPage[] {
	return tableCarries(pages).map(({ page, carry }) => (carry ? { ...page, markdown: page.markdown.replace(carry.from, carry.to) } : page));
}

/** For each page, the header carried onto it: the reader's `row` + rule (`from`) becomes header, rule, row (`to`). */
function tableCarries(pages: ConvertedPage[]): { page: ConvertedPage; carry?: { from: string; to: string } }[] {
	let header: string | undefined;
	return pages.map((page) => {
		const lines = page.markdown.split("\n");
		const filled = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim());
		const first = filled.findIndex(([l]) => TABLE_ROW.test(l));
		let carry: { from: string; to: string } | undefined;
		if (header && first >= 0 && first <= 3 && !filled.slice(0, first).some(([l]) => /^#{1,6}\s/.test(l.trim()))) {
			const at = filled[first][1];
			const row = lines[at].trim();
			const rule = (lines[at + 1] ?? "").trim();
			if (TABLE_RULE.test(rule) && cells(row) === cells(header) && !sameHeader(row, header) && dataLike(row)) {
				carry = { from: `${row}\n${rule}`, to: `${header.trim()}\n${rule}\n${row}` };
			}
		}
		const markdown = carry ? page.markdown.replace(carry.from, carry.to) : page.markdown;
		header = lastTableHeader(markdown);
		return { page, carry };
	});
}

/** The header of the table a page ends with (nothing but blank lines after it), else undefined. */
function lastTableHeader(markdown: string): string | undefined {
	const lines = markdown.split("\n");
	let end = lines.length - 1;
	while (end >= 0 && !lines[end].trim()) end--;
	if (end < 0 || !TABLE_ROW.test(lines[end])) return undefined;
	let start = end;
	while (start > 0 && TABLE_ROW.test(lines[start - 1])) start--;
	return TABLE_RULE.test(lines[start + 1] ?? "") && headerLike(lines[start]) ? lines[start] : undefined;
}
