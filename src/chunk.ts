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
	for (const { page, markdown } of pages) {
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
