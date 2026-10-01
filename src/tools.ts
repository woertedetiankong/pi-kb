/**
 * The agent's tools: kb_search, kb_list, kb_read, kb_add and kb_note. What they need from the
 * running extension (the knowledge bases in reach, the import queue, the UI language) comes in as
 * a ToolHost, so this file holds no state of its own.
 */
import { type AgentToolResult, type ExtensionAPI, type ExtensionContext, formatDimensionNote, resizeImage, type Theme, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename, extname } from "node:path";
import { Type } from "typebox";
import { type Messages, messages } from "./i18n.ts";
import { type AddResult, formatCitation, type KnowledgeBase, type NoteMode, type PageOcr, pathsOutside } from "./kb.ts";
import type { Library, Scope } from "./library.ts";
import { formatList, matching } from "./list.ts";
import { renderNote } from "./notes.ts";
import { type ProjectKb, projectRootFor } from "./project.ts";
import type { ImportJob, ImportQueue } from "./queue.ts";
import { type AddSummary, addCall, addResult, type HitSummary, listCall, listResult, noteCall, noteResult, readCall, readResult, searchCall, searchResult } from "./render.ts";
import type { SearchHit } from "./store.ts";

/** What pi passes a tool renderer (the type is not exported by name). */
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const READ_LIMIT = 30_000;
/** kb_read view: pages rendered per call. Each page image costs roughly 1.5k tokens or more. */
const VIEW_LIMIT = 4;
/** kb_read or kb_note on an item in a collection the project does not use: the same answer as for an unknown id, but saying why. */
const HIDDEN = "That document or note is in a collection the user keeps out of this project, so it cannot be used here. Do not look for other ways to read it; if the user needs it, they can add its collection with /kb use.";
/** How long kb_add waits for an import before leaving it to finish in the background. */
const KB_ADD_WAIT = 30_000;
/** Model-facing text is English regardless of the interface language. */
const MODEL = messages("en");

/** What the tools use of the running extension. */
export interface ToolHost {
	/** The knowledge bases in reach here (synced if their folders changed). */
	lib(): Library;
	/** This project's own knowledge base, if it has one. */
	project(): { kb: KnowledgeBase; info: ProjectKb } | undefined;
	imports: ImportQueue;
	/** Interface text in the user's language. */
	t(): Messages;
	/** Repaint the status bar. */
	refresh(ctx: ExtensionContext): void;
	startImport(
		paths: string[],
		cwd: string,
		note: boolean,
		ctx: ExtensionContext,
		scope?: Scope,
		shelving?: { shelf?: string; byFolder?: boolean; unreviewed?: boolean },
	): Promise<{ job: ImportJob; placed: Record<Scope, number> } | undefined>;
	/** Tell the user an import that went on in the background has finished. */
	reportImport(results: AddResult[]): void;
	/** Whether the agent may look in a collection (asks the user when the project does not use it). */
	reachShelf(shelf: string, ctx: ExtensionContext): Promise<boolean>;
	/** What the agent is told when a collection stays closed. */
	closedShelf(shelf: string, ctx: ExtensionContext): string;
}

/** A page counts as scanned when at least half its text came from OCR. */
const OCR_MOSTLY = 0.5;
/** Fewer OCR characters than this on a page are usually a logo or noise, not worth a warning. */
const OCR_SOME = 20;

/** "1-3, 7" from [1, 2, 3, 7]. */
export function pageList(pages: number[]): string {
	const out: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
		out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
		i = j;
	}
	return out.join(", ");
}

/**
 * Tell the model which text came from OCR, so it treats exact values there with care and, when it
 * can see images, checks them on the page. Images imported before OCR shares were recorded are
 * all OCR. Empty when nothing needs saying.
 */
export function ocrHint(ocr: PageOcr[], kind: string, canView: boolean): string {
	const shares = !ocr.length && kind === "image" ? [{ page: null, chars: 1, total: 1 }] : ocr;
	const mostly = shares.filter((o) => o.chars >= o.total * OCR_MOSTLY);
	const some = shares.filter((o) => !mostly.includes(o) && o.chars >= OCR_SOME);
	if (!mostly.length && !some.length) return "";
	const pages = (list: PageOcr[]) => pageList(list.map((o) => o.page).filter((p): p is number => p !== null));
	const parts: string[] = [];
	if (mostly.length) {
		const where = mostly[0].page === null ? "This text" : `The text of page ${pages(mostly)}`;
		parts.push(`${where} was read from an image by OCR and may have wrong words, numbers or word order.`);
	}
	if (some.length) parts.push(`Page ${pages(some)} has some text read by OCR from pictures on the page (figures, diagrams, scanned parts).`);
	const flagged = mostly.length + some.length;
	const target = mostly[0]?.page === null ? "the image" : flagged > 1 ? "these pages" : "this page";
	parts.push(canView ? `Check exact values by viewing ${target} (kb_read with view: true).` : "Treat exact values from OCR text with care.");
	return `[OCR: ${parts.join(" ")}]`;
}

/** Whether the current model accepts images; unknown models are assumed to, as pi's own read tool does. */
export function seesImages(ctx: Pick<ExtensionContext, "model">): boolean {
	return !ctx.model || ctx.model.input.includes("image");
}

export function formatHits(hits: (SearchHit & { scope?: Scope; unreviewed?: boolean })[], m: Messages, scoped = false): string {
	return hits
		.map((hit, i) => {
			const where = [scoped && hit.scope && m.scopeTag[hit.scope], hit.heading && `§ ${hit.heading}`, hit.collection === "wiki" && (hit.unreviewed ? m.unreviewedNote : m.wikiNote), hit.match === "semantic" && m.semanticMatch]
				.filter(Boolean)
				.join(" · ");
			return `${i + 1}. ${formatCitation(hit)} id=${hit.docId}${where ? ` · ${where}` : ""}\n   ${hit.snippet}`;
		})
		.join("\n");
}

export function summarizeAdds(results: AddResult[], m: Messages): string {
	const count = (s: AddResult["status"]) => results.filter((r) => r.status === s).length;
	// Documents read again (after the OCR settings changed) are no import: "added 0" would be confusing.
	const reread = count("updated");
	const lines = [
		reread && !count("added") && !count("exists")
			? [m.rereadSummary(reread), count("failed") || count("skipped") ? m.addSummary(0, 0, count("skipped"), count("failed")) : ""].filter(Boolean).join(" ")
			: m.addSummary(count("added"), count("exists"), count("skipped"), count("failed")),
	];
	for (const r of results) {
		const label = r.doc ? `${r.doc.title} (${r.doc.id}${r.doc.pages ? `, ${m.pages(r.doc.pages)}` : ""})` : r.path;
		const why =
			r.reason === "unsupported"
				? m.reasons.unsupported(extname(r.path) || "(none)")
				: r.reason
					? m.reasons[r.reason]
					: r.replaced?.length
						? m.replacedOld
						: r.message;
		lines.push(`- ${m.addStatus[r.status]}: ${label}${why ? ` — ${why}` : ""}`);
	}
	return lines.join("\n");
}

/** One Text component per tool row, reused across redraws. */
export const line = (text: string, context: ToolRenderContext) => {
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
};
/**
 * A tool's result line: `summary` when it worked, its message when it failed (the whole message
 * when expanded).
 */
export const resultLine = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext, summary: () => string) => {
	if (!context.isError) return line(summary(), context);
	const first = result.content.find((c) => c.type === "text");
	const message = first?.type === "text" ? first.text : "";
	return line(theme.fg("error", options.expanded ? message : message.split("\n")[0]), context);
};
export const textOf = (result: AgentToolResult<unknown>) => {
	const first = result.content.find((c) => c.type === "text");
	return first?.type === "text" ? first.text : "";
};

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	const { lib, imports, t, refresh, startImport, reportImport, reachShelf, closedShelf } = host;

	pi.registerTool({
		name: "kb_search",
		label: "KB Search",
		description:
			"Search the user's knowledge base (imported documents and wiki notes). Returns ranked snippets with citations like [file.pdf p.12] and document ids for kb_read.",
		promptSnippet: "Search the user's knowledge base of documents and experience notes",
		promptGuidelines: ["Use kb_search with 1-4 short keywords rather than a full sentence."],
		parameters: Type.Object({
			query: Type.String({ description: "Keywords, e.g. 'VDD 供电电压' or 'SPI clock divider'" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("all"), Type.Literal("docs"), Type.Literal("wiki")], {
					description:
						"Leave as all (default) unless the user asks for only documents or only notes: wiki notes often hold the lessons that answer questions about documents",
				}),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results (default 8)" })),
			shelf: Type.Optional(
				Type.String({
					description:
						"Search only this collection of the user's global knowledge base (names are in the system prompt), e.g. when the user asks to look in their STM32 documents. Leave it out otherwise: the search already covers what this project uses",
				}),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const project = host.project();
			const scope = params.scope && params.scope !== "all" ? params.scope : undefined;
			const library = lib();
			const known = library.shelfList();
			const shelf = params.shelf?.trim() ? known.find((s) => s.name.toLowerCase() === params.shelf!.trim().toLowerCase())?.name : undefined;
			if (params.shelf?.trim() && !shelf) {
				const text = `No collection named "${params.shelf}". ${known.length ? `The collections are: ${known.map((s) => s.name).join(", ")}.` : "The knowledge base has no collections."} Search again with one of them, or without shelf.`;
				return { content: [{ type: "text", text }], details: { hits: [], pending: [] } };
			}
			if (shelf && !(await reachShelf(shelf, ctx))) return { content: [{ type: "text", text: closedShelf(shelf, ctx) }], details: { hits: [], pending: [] } };
			const hits = (await library.find(params.query, { limit: params.limit, collection: scope, shelf })).map((h) =>
				h.collection === "wiki" && library.unreviewed(h) ? { ...h, unreviewed: true } : h,
			);
			// A part the knowledge base never mentions: its results are about other parts, with other values.
			const missing = library.unmentioned(params.query);
			const unknown = missing.length
				? `Note: nothing in the knowledge base mentions ${missing.join(", ")}. ${hits.length ? "The results below are about other things; do not give their values as those of " + missing.join(", ") + ". " : ""}Tell the user the knowledge base has nothing on ${missing.length > 1 ? "them" : "it"} (use kb_list to show what similar items it has).\n\n`
				: "";
			let text = unknown + (hits.length
				? formatHits(hits, MODEL, !!project)
				: unknown
					? ""
					: "No matches. Search matches words: try fewer or different keywords, synonyms, the wording a manual would use, or the other language (documents are often in English when the user writes Chinese).");
			// Files still importing are not searchable yet; without this the model tells the user the knowledge base lacks them.
			const pending = imports.pending();
			if (pending.length) {
				const names = pending.slice(0, 5).map((p) => basename(p)).join(", ") + (pending.length > 5 ? ", …" : "");
				text += `\n\nNote: ${pending.length} file(s) are still being imported (${names}) and are not searchable yet. If the results above do not answer the user, say that the import is still running and suggest asking again when it finishes; do not say the knowledge base lacks the information.`;
			}
			// PDFs searchable by their text layer while OCR still reads their pictures.
			const reading = library.ocrPending();
			if (reading.length) {
				const names = reading.slice(0, 5).map((d) => d.title).join(", ") + (reading.length > 5 ? ", …" : "");
				text += `\n\nNote: text inside pictures (figure labels, scanned pages) of ${reading.length} document(s) is still being read by OCR (${names}); their other text is searchable. If something that would be in a figure is missing, ${seesImages(ctx) ? "look at the page with kb_read view: true, or " : ""}say the pictures are still being read.`;
			}
			return { content: [{ type: "text", text }], details: { hits, pending, missing } };
		},
		renderCall: (args, theme, context) => line(searchCall(theme, t(), args), context),
		renderResult: (result, options, theme, context) =>
			resultLine(result, options, theme, context, () => {
				const details = result.details as { hits?: HitSummary[]; pending?: string[]; missing?: string[] } | undefined;
				return searchResult(theme, t(), details?.hits ?? [], details?.pending?.length ?? 0, options.expanded, details?.missing);
			}),
	});

	pi.registerTool({
		name: "kb_list",
		label: "KB List",
		description:
			"List the documents and wiki notes in the user's knowledge base by title, with pages, date added and id. Use it when the user asks what the knowledge base holds, whether a file is in it, or what they imported; not for questions about the content (use kb_search).",
		promptSnippet: "List the documents and notes in the user's knowledge base",
		parameters: Type.Object({
			match: Type.Optional(Type.String({ description: "Only titles or file paths containing this text, e.g. 'esp32' or '.pdf'" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("all"), Type.Literal("docs"), Type.Literal("wiki")], { description: "Only documents (docs) or only notes (wiki); default all" }),
			),
			shelf: Type.Optional(Type.String({ description: "Only this collection of the user's global knowledge base (names are in the system prompt)" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Continue a long list from here" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const project = host.project();
			const library = lib();
			const collection = params.scope && params.scope !== "all" ? params.scope : undefined;
			const known = library.shelfList();
			const shelf = params.shelf?.trim() ? known.find((s) => s.name.toLowerCase() === params.shelf!.trim().toLowerCase())?.name : undefined;
			if (params.shelf?.trim() && !shelf) {
				const text = `No collection named "${params.shelf}". ${known.length ? `The collections are: ${known.map((s) => s.name).join(", ")}.` : "The knowledge base has no collections."}`;
				return { content: [{ type: "text", text }], details: { docs: 0, notes: 0 } };
			}
			if (shelf && !(await reachShelf(shelf, ctx))) return { content: [{ type: "text", text: closedShelf(shelf, ctx) }], details: { docs: 0, notes: 0 } };
			const docs = library.visibleDocs({ collection, shelf });
			let text = formatList(docs, { match: params.match, offset: params.offset, scoped: !!project });
			const pending = imports.pending();
			if (pending.length) text += `\n\nAlso ${pending.length} file(s) still being imported, not listed yet: ${pending.slice(0, 5).map((p) => basename(p)).join(", ")}${pending.length > 5 ? ", …" : ""}.`;
			const shown = matching(docs, params.match);
			const count = shown.filter((d) => d.collection === "docs").length;
			return { content: [{ type: "text", text }], details: { docs: count, notes: shown.length - count } };
		},
		renderCall: (args, theme, context) => line(listCall(theme, t(), args), context),
		renderResult: (result, options, theme, context) =>
			resultLine(result, options, theme, context, () => listResult(theme, t(), result.details as { docs?: number; notes?: number } | undefined)),
	});

	pi.registerTool({
		name: "kb_read",
		label: "KB Read",
		description:
			"Read a knowledge base document or wiki note by id, optionally only some pages (e.g. '12' or '12-14'). Use after kb_search to see full context.",
		parameters: Type.Object({
			id: Type.String({ description: "Document id from kb_search, e.g. k-1a2b3c4d5e6f or w-…" }),
			pages: Type.Optional(Type.String({ description: "Page or range for paged documents, e.g. '12' or '12-14'" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for continuing a long read" })),
			view: Type.Optional(
				Type.Boolean({
					description: `Also return pictures of the pages, rendered from the original, to see figures, diagrams, schematics and layout the text loses. At most ${VIEW_LIMIT} pages; paged documents need pages.`,
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			// Only what kb_search can find here: the user keeps other collections out of this project.
			if (lib().locate(params.id) && !lib().sees(params.id)) return { content: [{ type: "text", text: HIDDEN }], details: { id: params.id, offset: 0, truncated: false, viewed: [] } };
			const { doc, text, ocr } = lib().read(params.id, params.pages);
			const offset = params.offset ?? 0;
			const slice = text.slice(offset, offset + READ_LIMIT);
			const more = offset + READ_LIMIT < text.length;
			const header = `${doc.title} (${doc.id}${doc.pages ? `, ${doc.pages} pages` : ""})`;
			const footer = more ? `\n\n[Truncated. Continue with offset=${offset + READ_LIMIT} or narrow pages.]` : "";
			// Not repeated once the pages are shown.
			const hint = params.view ? "" : ocrHint(ocr, doc.kind, seesImages(ctx));
			const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
				{ type: "text", text: `${header}${hint ? `\n${hint}` : ""}\n\n${slice}${footer}` },
			];
			const viewed: number[] = [];
			if (params.view) {
				// The text is still useful when the pages cannot be shown, so say why instead of failing.
				const note = (message: string) => content.push({ type: "text", text: `[Page images not shown: ${message}]` });
				if (!seesImages(ctx)) note("the current model does not accept images");
				else {
					try {
						const { images } = await lib().renderPages(params.id, params.pages, VIEW_LIMIT, signal);
						for (const image of images) {
							const resized = await resizeImage(image.png, "image/png");
							if (!resized) continue;
							const label = doc.pages ? `Page ${image.page} of ${doc.title}` : doc.title;
							const dimensions = formatDimensionNote(resized);
							content.push({ type: "text", text: dimensions ? `${label} ${dimensions}` : label });
							content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
							viewed.push(image.page);
						}
						if (!viewed.length) note("the pages could not be rendered");
					} catch (error) {
						note(error instanceof Error ? error.message : String(error));
					}
				}
			}
			return {
				content,
				details: { id: doc.id, offset, truncated: more, viewed },
			};
		},
		renderCall: (args, theme, context) => {
			// The title says more than the id; looked up once per row.
			const state = context.state as { title?: string } | undefined;
			let title = state?.title;
			if (!title) {
				try {
					title = lib().locate(args.id)?.doc.title;
				} catch {
					// knowledge base closed or moved: show the id
				}
				if (state && title) state.title = title;
			}
			return line(readCall(theme, t(), args, title), context);
		},
		renderResult: (result, options, theme, context) =>
			resultLine(result, options, theme, context, () =>
				readResult(theme, t(), textOf(result), result.details as { truncated?: boolean; viewed?: number[] } | undefined, options.expanded),
			),
	});

	pi.registerTool({
		name: "kb_add",
		label: "KB Add",
		description:
			"Import files or folders into the user's knowledge base. Use only when the user asks to save something to the knowledge base. Markdown sent with as_note=true becomes a wiki note. Paths outside the project folder need the user's confirmation. Large files may finish importing in the background.",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, description: "Files or folders to import" }),
			as_note: Type.Optional(Type.Boolean({ description: "Store Markdown files as wiki notes (experience, lessons)" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description:
						"project: this project's shared knowledge base; global: the user's personal one. Leave it out to put files inside this project into the project's and files from elsewhere into the global one",
				}),
			),
			shelf: Type.Optional(Type.String({ description: "Put them in this collection of the global knowledge base (implies scope global); only when the user names one" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = host.project();
			// The model may be steered by text it read (a prompt injection); copying a file from elsewhere
			// into the knowledge base keeps it and may send it to an embeddings API, so the user decides.
			const outside = pathsOutside(params.paths, ctx.cwd);
			if (outside.length) {
				const allowed = ctx.hasUI && (await ctx.ui.confirm(t().outsideTitle, t().outsideBody(outside)));
				if (!allowed) {
					const text = ctx.hasUI
						? `The user chose not to import ${outside.join(", ")}; nothing was imported. Do not retry on your own, but if the user asks for it again, call kb_add again: they will be asked again.`
						: `Nothing was imported: ${outside.join(", ")} is outside the project folder and there is no user to confirm. Ask the user to run /kb add with the path.`;
					return { content: [{ type: "text", text }], details: { added: 0, exists: 0, failed: 0, declined: true } as AddSummary };
				}
			}
			const shelf = params.shelf?.trim() || undefined;
			// Notes the agent imports with nobody watching are marked, as kb_note's are: otherwise writing a file and importing it skips the review.
			const started = await startImport(params.paths, ctx.cwd, params.as_note ?? false, ctx, project && !shelf ? params.scope : "global", { shelf, unreviewed: !ctx.hasUI });
			if (!started) {
				const text = "The user cancelled this import; nothing was imported. Do not retry on your own, but if the user asks for it again, call kb_add again.";
				return { content: [{ type: "text", text }], details: { added: 0, exists: 0, failed: 0, declined: true } as AddSummary };
			}
			const { job, placed } = started;
			const placement =
				project && !params.scope && placed.global
					? `${placed.global} file(s) from outside this project went to the user's global knowledge base, not the project's; call kb_add with scope project only if the user wants them shared with the team.`
					: "";
			let timer: NodeJS.Timeout | undefined;
			const finished = await Promise.race([
				job.done.then(() => true),
				new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), KB_ADD_WAIT))),
			]);
			clearTimeout(timer);
			const count = (...statuses: AddResult["status"][]) => job.results.filter((r) => statuses.includes(r.status)).length;
			const summary: AddSummary = { added: count("added", "updated"), exists: count("exists"), failed: count("failed") };
			if (finished) return { content: [{ type: "text", text: [summarizeAdds(job.results, MODEL), placement].filter(Boolean).join("\n") }], details: summary };
			// A long manual: let it finish in the background and tell the user then.
			void job.done.then(reportImport);
			const text = [
				`Still importing in the background: ${job.results.length} of ${job.total} file(s) done so far. Each file becomes searchable as soon as it is done, and the user is notified when all are finished. Do not wait or poll for it; tell the user it is importing.`,
				job.results.length ? summarizeAdds(job.results, MODEL) : "",
				placement,
			].filter(Boolean).join("\n");
			return { content: [{ type: "text", text }], details: { ...summary, background: { done: job.results.length, total: job.total } } };
		},
		renderCall: (args, theme, context) => line(addCall(theme, t(), args), context),
		renderResult: (result, options, theme, context) =>
			resultLine(result, options, theme, context, () => addResult(theme, t(), result.details as AddSummary | undefined)),
	});

	pi.registerTool({
		name: "kb_note",
		label: "KB Note",
		description:
			"Save a lesson, fix, decision or user preference as a wiki note in the knowledge base so future sessions can find it. The user reviews the note before it is saved. To extend or correct an existing note, pass its id with mode append or replace.",
		promptSnippet: "Save lasting lessons and experience as knowledge base wiki notes",
		promptGuidelines: [
			"Write kb_note content so it is useful without this conversation: symptom, root cause, fix, and how to recognize it next time, with concrete names, versions and commands.",
			"Before creating a note, check kb_search with scope wiki; if a related note exists, use mode append with its id.",
			"With mode append, write only what is new, under a heading that names the new point; do not repeat the existing note.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short, searchable title, e.g. 'XR-100 SPI 需要先设置时钟分频'" }),
			content: Type.String({ description: "Markdown body of the note (no front matter)" }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "A few lowercase keywords, e.g. ['spi', 'xr100']" })),
			mode: Type.Optional(
				Type.Union([Type.Literal("create"), Type.Literal("append"), Type.Literal("replace")], {
					description: "create a new note (default), or append to / replace an existing note given by id",
				}),
			),
			id: Type.Optional(Type.String({ description: "Existing wiki note id (w-…) for append or replace" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description:
						"Only when this project has its own knowledge base. project: only concerns this project, shared with the team; global: reusable or personal. Ignored for append and replace (the note stays where it is)",
				}),
			),
			shelf: Type.Optional(
				Type.String({
					description:
						"For a new note in the global knowledge base: one of the collections this project uses (see the system prompt) when the lesson is about its topic, so projects on other topics are not cluttered with it. Leave it out for user preferences and general lessons, which every project should see",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = host.project();
			const library = lib();
			let mode: NoteMode = params.mode ?? "create";
			let noteId = params.id;
			if (mode !== "create" && noteId && library.locate(noteId) && !library.sees(noteId)) return { content: [{ type: "text", text: HIDDEN }], details: { saved: false } };
			// An existing note stays in its knowledge base; a new one goes where the model said (or the project's).
			let scope: Scope = mode !== "create" && noteId ? (library.locate(noteId)?.scope ?? "global") : project ? (params.scope ?? "project") : "global";
			// The project's name, not the subfolder pi happens to run in.
			// A collection named by the model: an existing one's spelling; any other name starts a new one.
			let shelf = params.shelf?.trim() ? library.shelfName(params.shelf) : undefined;
			const shelvesFor = (where: Scope) => (where === "global" && shelf ? [shelf] : undefined);
			// Without a UI nobody reviews the note: it is marked until the user approves it (/kb lint, web page).
			let input = { ...params, project: basename(project?.info.root ?? projectRootFor(ctx.cwd)) || undefined, shelves: shelvesFor(scope), unreviewed: !ctx.hasUI };
			let base = library.kb(scope);
			let prepared = base.prepareNote(input, mode, noteId);
			// Notes that may already say this (in either language, with semantic search): adding to one keeps the wiki from splitting.
			// Notes in collections the project does not use stay out of the model's sight (the user still sees them).
			const similar = mode === "create" ? await library.similarNotes(params.title) : [];
			const similarSeen = similar.filter((d) => library.sees(d.id));
			let edited: string | undefined;
			if (ctx.hasUI) {
				const m = t();
				const name = project?.info.name ?? "";
				try {
					for (;;) {
						const preview = renderNote(prepared.note);
						const title = prepared.existing?.title ?? "";
						const verb = mode === "create" ? m.noteNew : mode === "append" ? m.noteAppend(title) : m.noteReplace(title);
						// A new global note shows its collection: it decides which projects see it.
						const shelfNow = mode === "create" && scope === "global" && (shelf || library.shelfList().length) ? ` · ${m.noteShelf(shelf)}` : "";
						const whereNow = `${project ? ` → ${m.scopeLabel(scope, name)}` : ""}${shelfNow}`;
						const alike = mode === "create" && similar.length ? [m.noteSimilar, ...similar.map((d) => `  • ${d.title}${project ? ` ${m.scopeTag[d.scope]}` : ""}`), ""] : [];
						ctx.ui.setWidget("kb", [`📚 ${verb}${whereNow}`, ...alike, ...preview.split("\n").slice(0, 40)]);
						const [save, edit, skip] = m.noteChoices;
						const appendTo = mode === "create" ? similar.slice(0, 2).map((d) => ({ d, label: m.noteAppendInstead(d.title) })) : [];
						// A new note can go to the other knowledge base instead: the user decides what the team sees.
						const other: Scope = scope === "project" ? "global" : "project";
						const switchTo = project && mode === "create" ? m.noteSwitch(m.scopeLabel(other, name)) : undefined;
						const shelfChange = shelfNow ? m.noteShelfChange : undefined;
						const choices = [save, ...appendTo.map((a) => a.label), edit, ...(switchTo ? [switchTo] : []), ...(shelfChange ? [shelfChange] : []), skip];
						const choice = await ctx.ui.select(m.noteAsk(prepared.note.meta.title) + whereNow, choices);
						if (shelfChange && choice === shelfChange) {
							// The project's collections first (all of them when it uses all), then none.
							const names = library.shelfList().filter((s) => s.used).map((s) => s.name);
							const picked = await ctx.ui.select(m.noteShelfPick, [m.noteShelfNone, ...names]);
							if (picked !== undefined) {
								shelf = picked === m.noteShelfNone ? undefined : picked;
								input = { ...input, shelves: shelvesFor(scope) };
								prepared = base.prepareNote(input, mode, noteId);
							}
							continue;
						}
						const into = appendTo.find((a) => a.label === choice)?.d;
						if (into) {
							// Added to that note as a section under the new title, then shown again for review.
							mode = "append";
							noteId = into.id;
							scope = into.scope;
							base = library.kb(scope);
							const content = /^#{1,6}\s/.test(params.content.trim()) ? params.content : `# ${params.title}\n\n${params.content}`;
							input = { ...input, content };
							prepared = base.prepareNote(input, mode, noteId);
							continue;
						}
						if (switchTo && choice === switchTo) {
							scope = other;
							base = library.kb(scope);
							input = { ...input, shelves: shelvesFor(scope) };
							prepared = base.prepareNote(input, mode, noteId);
						} else if (choice === edit) edited = await ctx.ui.editor(m.noteEditor, preview);
						if (!(choice === save || choice === switchTo || (choice === edit && edited !== undefined))) {
							return {
								content: [{ type: "text", text: "The user chose not to save this note. Do not retry on your own, but if the user asks for it again, call kb_note again: they will review it again." }],
								details: { saved: false },
							};
						}
						break;
					}
				} finally {
					ctx.ui.setWidget("kb", undefined);
				}
			}
			const doc = base.writeNote(prepared, edited);
			refresh(ctx);
			const onShelf = scope === "global" && doc.collection === "wiki" ? base.store.shelvesOf(doc.id) : [];
			const where = `${project ? ` in the ${scope === "project" ? `project knowledge base "${project.info.name}" (shared with the team once committed)` : "user's global knowledge base"}` : ""}${onShelf.length ? `, collection ${onShelf.join(", ")}` : ""}`;
			const redirected = (params.mode ?? "create") === "create" && mode === "append";
			const text = [
				redirected
					? `The user chose to add this to the existing note "${doc.title}" (${doc.id}) instead of creating a new one: it was appended as a section${where}${edited !== undefined ? " after the user edited it" : ""}.`
					: `Saved wiki note "${doc.title}" (${doc.id})${where} at ${doc.path}${edited !== undefined ? " after the user edited it" : ""}${ctx.hasUI ? "" : ", marked unreviewed until the user approves it"}.`,
				// Without a UI nobody chose: tell the model, so related lessons end up in one note next time.
				!ctx.hasUI && similarSeen.length
					? `Similar notes already exist: ${similarSeen.map((d) => `"${d.title}" (${d.id})`).join(", ")}. If one covers the same topic, extend it with mode append and its id instead of creating another note.`
					: "",
			].filter(Boolean).join("\n");
			return { content: [{ type: "text", text }], details: { saved: true, id: doc.id, title: doc.title } };
		},
		renderCall: (args, theme, context) => line(noteCall(theme, t(), args), context),
		renderResult: (result, options, theme, context) =>
			resultLine(result, options, theme, context, () => noteResult(theme, t(), result.details as { saved?: boolean; title?: string } | undefined)),
	});
}
