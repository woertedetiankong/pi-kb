import type { ScopedDoc } from "./library.ts";
import { today } from "./notes.ts";

/**
 * What kb_list tells the model: every document and note in reach, straight from the index (no
 * search, no embedding model), so "what is in my knowledge base?" gets a complete answer in one call.
 */

/** Entries per call; about 25 tokens each, so a page stays near 2,500 tokens. */
export const LIST_LIMIT = 100;

export interface ListOptions {
	/** Only titles or file paths containing this, ignoring case. */
	match?: string;
	offset?: number;
	limit?: number;
	/** Mark each entry [project] or [global] (inside a project that has its own knowledge base). */
	scoped?: boolean;
}

/** The folder a document was imported from, or undefined for uploads and notes. */
function folderOf(doc: ScopedDoc): string | undefined {
	if (doc.collection !== "docs") return undefined;
	const parts = doc.source.split(/[\\/]/).filter(Boolean);
	return parts.length > 1 ? parts[parts.length - 2] : undefined;
}

/** "ESP32 (45), sensors (12), …": where the documents came from, largest first. */
function groups(docs: ScopedDoc[], key: (d: ScopedDoc) => string[] | string | undefined, max = 12): string {
	const counts = new Map<string, number>();
	for (const doc of docs) for (const name of [key(doc) ?? []].flat()) counts.set(name, (counts.get(name) ?? 0) + 1);
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return sorted.slice(0, max).map(([name, n]) => `${name} (${n})`).join(", ") + (sorted.length > max ? `, … ${sorted.length - max} more` : "");
}

/** The documents and notes whose title or file path contains `match`, ignoring case; all of them without one. */
export function matching(docs: ScopedDoc[], match: string | undefined): ScopedDoc[] {
	const word = match?.trim().toLowerCase();
	return word ? docs.filter((d) => d.title.toLowerCase().includes(word) || d.source.toLowerCase().includes(word)) : docs;
}

export function formatList(all: ScopedDoc[], options: ListOptions = {}): string {
	const match = options.match?.trim();
	const found = matching(all, match);
	const docs = found.filter((d) => d.collection === "docs").sort((a, b) => a.title.localeCompare(b.title));
	const notes = found.filter((d) => d.collection === "wiki").sort((a, b) => a.title.localeCompare(b.title));
	const ordered = [...docs, ...notes];
	const offset = Math.max(0, options.offset ?? 0);
	const limit = options.limit ?? LIST_LIMIT;
	const page = ordered.slice(offset, offset + limit);
	const what = `${docs.length} document(s) and ${notes.length} wiki note(s)${match ? ` whose title or file path contains "${match}"` : ""}`;
	if (!ordered.length) return `${what}.${match && all.length ? " This checks titles and file paths only: kb_search finds documents that mention it in their text." : ""}`;
	if (!page.length) return `${what}; offset ${offset} is past the end.`;
	const lines = [`${what}.${ordered.length > page.length ? ` Showing ${offset + 1}-${offset + page.length}, documents then notes, by title.` : ""}`];
	// A long list starts with where things came from, so a summary question needs no second page.
	if (ordered.length > limit) {
		const shelves = groups(found, (d) => d.shelves);
		const folders = groups(docs, folderOf);
		if (shelves) lines.push(`Collections: ${shelves}`);
		if (folders) lines.push(`Imported from folders: ${folders}`);
	}
	let section: string | undefined;
	for (const doc of page) {
		const heading = doc.collection === "docs" ? "Documents:" : "Wiki notes:";
		if (heading !== section) lines.push(heading);
		section = heading;
		const facts = [
			doc.pages ? `${doc.pages} pages` : "",
			`added ${today(new Date(doc.added_at))}`,
			options.scoped ? doc.scope : "",
			doc.shelves?.length ? `collection ${doc.shelves.join(", ")}` : "",
		].filter(Boolean);
		lines.push(`- ${doc.title} · ${facts.join(" · ")} · id=${doc.id}`);
	}
	const rest = ordered.length - offset - page.length;
	if (rest > 0) lines.push(`${rest} more not shown: call kb_list with offset=${offset + page.length}, or narrow with match.`);
	return lines.join("\n");
}
