import type { Messages } from "./i18n.ts";

/**
 * How the knowledge base's tool calls look in pi's terminal: one line saying what the agent asked
 * and one saying what came back ("3 hits · manual.pdf p.12, 14 · note …"), so the user sees when
 * the knowledge base helped. Plain functions over a theme's colors, so they can be tested without a terminal.
 */

/** The parts of pi's Theme used here. */
export interface Style {
	fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim" | "toolTitle" | "toolOutput", text: string): string;
	bold(text: string): string;
}

/** What kb_search keeps of each hit (a ScopedHit). */
export interface HitSummary {
	title: string;
	page: number | null;
	collection: "docs" | "wiki";
	snippet?: string;
}

/** Documents listed on the result line before "+N more". */
const SHOWN = 3;

/** Pages sorted, with runs as ranges: [150, 132, 148, 149] → ["132", "148-150"]. */
export function pageRuns(pages: number[]): string[] {
	const sorted = [...new Set(pages)].sort((x, y) => x - y);
	const runs: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
		i = j;
	}
	return runs;
}

/** A snippet without Markdown marks that mean nothing in a terminal line: headings, bold, table rules. */
export function plainSnippet(snippet: string): string {
	return snippet
		.replace(/(^|\s)#{1,6}\s+/g, "$1")
		.replace(/\*\*/g, "")
		.replace(/\|?\s*(?:-{3,}\s*\|\s*)+/g, "| ")
		.replace(/(?:\s*\|\s*){2,}/g, " | ")
		.replace(/\s+/g, " ")
		.trim();
}

const head = (s: Style, m: Messages, action: string) => `${s.fg("toolTitle", s.bold(m.toolKb))} ${s.fg("toolTitle", action)}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function searchCall(s: Style, m: Messages, args: { query?: string; scope?: string; shelf?: string }): string {
	const extra = [args.scope === "docs" ? m.toolOnlyDocs : args.scope === "wiki" ? m.toolOnlyNotes : "", args.shelf ? m.toolShelf(args.shelf) : ""].filter(Boolean);
	return `${head(s, m, m.toolSearch)} ${s.fg("accent", `"${clip(args.query ?? "", 80)}"`)}${extra.length ? s.fg("dim", ` · ${extra.join(" · ")}`) : ""}`;
}

/** "3 hits · manual.pdf p.12, 14 · note "SPI" · +1 more", then one line per hit when expanded. */
export function searchResult(s: Style, m: Messages, hits: HitSummary[], pending: number, expanded: boolean): string {
	const waiting = pending ? s.fg("dim", ` · ${m.toolImporting(pending)}`) : "";
	if (!hits.length) return s.fg("warning", m.toolNoHits) + waiting;
	// One entry per document or note, in rank order, with its pages.
	const groups = new Map<string, { hit: HitSummary; pages: number[] }>();
	for (const hit of hits) {
		const key = `${hit.collection}:${hit.title}`;
		const group = groups.get(key) ?? { hit, pages: [] };
		if (hit.page !== null && !group.pages.includes(hit.page)) group.pages.push(hit.page);
		groups.set(key, group);
	}
	const entries = [...groups.values()].map(({ hit, pages }) =>
		hit.collection === "wiki" ? m.toolNote(hit.title) : `${hit.title}${pages.length ? ` ${m.toolPages(pageRuns(pages))}` : ""}`,
	);
	const more = entries.length > SHOWN ? s.fg("dim", ` · ${m.toolMore(entries.length - SHOWN)}`) : "";
	let text = `${s.fg("success", m.toolHits(hits.length))} ${s.fg("dim", "·")} ${entries.slice(0, SHOWN).join(s.fg("dim", " · "))}${more}${waiting}`;
	if (expanded) {
		for (const hit of hits) {
			const cite = hit.page ? `[${hit.title} p.${hit.page}]` : `[${hit.title}]`;
			text += `\n${s.fg("accent", cite)} ${s.fg("dim", clip(plainSnippet(hit.snippet ?? ""), 140))}`;
		}
	}
	return text;
}

export function readCall(s: Style, m: Messages, args: { id?: string; pages?: string; view?: boolean }, title?: string): string {
	const pages = args.pages?.trim() ? ` ${m.toolPageRange(args.pages.trim())}` : "";
	return `${head(s, m, m.toolRead)} ${s.fg("accent", title ?? args.id ?? "")}${s.fg("dim", pages)}${args.view ? s.fg("dim", ` · ${m.toolWithPictures}`) : ""}`;
}

/** "4,210 characters · 🖼 2 pages viewed", then the start of the text when expanded. */
export function readResult(s: Style, m: Messages, text: string, details: { truncated?: boolean; viewed?: number[] } | undefined, expanded: boolean): string {
	// The text starts with a "<title> (<id>…)" line and a blank line; the rest is what was read.
	// Page markers are for citations, not text the user would count.
	const body = text.replace(/^[^\n]*\n(?:[^\n]*\n)?\n/, "").replace(/^<!-- kb:[^\n]*-->\n?/gm, "");
	const parts = [s.fg("success", m.toolChars(body.length))];
	if (details?.viewed?.length) parts.push(s.fg("success", `🖼 ${m.toolViewed(details.viewed.length)}`));
	if (details?.truncated) parts.push(s.fg("dim", m.toolTruncated));
	let out = parts.join(s.fg("dim", " · "));
	if (expanded) {
		const lines = body.split("\n").filter((l) => l.trim());
		for (const line of lines.slice(0, 12)) out += `\n${s.fg("dim", clip(line, 160))}`;
		if (lines.length > 12) out += `\n${s.fg("muted", m.toolMoreLines(lines.length - 12))}`;
	}
	return out;
}

export function addCall(s: Style, m: Messages, args: { paths?: string[]; as_note?: boolean }): string {
	const paths = args.paths ?? [];
	const names = paths.slice(0, 2).map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
	const more = paths.length > 2 ? ` ${m.toolMore(paths.length - 2)}` : "";
	return `${head(s, m, args.as_note ? m.toolAddNotes : m.toolAdd)} ${s.fg("accent", names.join(", "))}${s.fg("dim", more)}`;
}

/** What kb_add reports in its details. */
export interface AddSummary {
	added: number;
	exists: number;
	failed: number;
	/** Still importing in the background: done so far of total. */
	background?: { done: number; total: number };
	declined?: boolean;
}

export function addResult(s: Style, m: Messages, summary: AddSummary | undefined): string {
	if (!summary) return "";
	if (summary.declined) return s.fg("muted", m.toolNotImported);
	const parts: string[] = [];
	if (summary.background) parts.push(s.fg("warning", m.toolBackground(summary.background.done, summary.background.total)));
	if (summary.added) parts.push(s.fg("success", m.toolAdded(summary.added)));
	if (summary.exists) parts.push(s.fg("dim", m.toolExists(summary.exists)));
	if (summary.failed) parts.push(s.fg("error", m.toolFailed(summary.failed)));
	return parts.join(s.fg("dim", " · ")) || s.fg("muted", m.toolNothing);
}

export function noteCall(s: Style, m: Messages, args: { title?: string; mode?: string }): string {
	const action = args.mode === "append" ? m.toolNoteAppend : args.mode === "replace" ? m.toolNoteReplace : m.toolNoteNew;
	return `${head(s, m, action)} ${s.fg("accent", `"${clip(args.title ?? "", 80)}"`)}`;
}

export function noteResult(s: Style, m: Messages, details: { saved?: boolean; title?: string } | undefined): string {
	if (!details) return "";
	return details.saved ? s.fg("success", `✓ ${m.toolSaved(details.title ?? "")}`) : s.fg("muted", m.toolNotSaved);
}
