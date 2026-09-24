/**
 * Some models (gpt-6-luna in our checks) fix a bug or hear "from now on, use X" and stop without
 * calling kb_note, however the system prompt puts it. So before a run settles, the extension looks
 * at what happened and, in two narrow cases, asks the model once more whether to save a note.
 */

export const NUDGE_TYPE = "kb-note-nudge";

export type NudgeReason = "debugged" | "told";

/** The parts of pi's agent messages this check reads. */
interface Message {
	role: string;
	content?: unknown;
	customType?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface Part {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: { command?: unknown };
}

const EDIT_TOOLS = new Set(["edit", "write"]);
/** Shell commands that change files: sed -i, redirects into a file, tee, mv/cp, scripts that write. */
const SHELL_WRITE =
	/\bsed\s+(-\w*\s+)*-i|\bperl\s+-\w*i|(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[\w./~"'-]|\btee\b|\b(mv|cp)\s|write_(bytes|text)\(|writeFileSync\(|open\([^)]*["'][wa]b?["']/;

/** Whether a shell command changes files. */
export function shellWrites(command: string): boolean {
	return SHELL_WRITE.test(command);
}

/** "From now on…", "remember…": the user is stating something meant to last beyond this chat. */
const LASTING = /以后|今后|往后|记住|记下|别忘|from now on|going forward|in (?:the )?future|remember (?:that|this)|keep in mind/i;

const parts = (m: Message): Part[] => (Array.isArray(m.content) ? (m.content as Part[]) : []);
const text = (m: Message): string =>
	typeof m.content === "string" ? m.content : parts(m).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");

/**
 * Why to remind the model about kb_note after this run, or undefined. Looks only at messages since
 * the user's last message, and never reminds twice or after kb_note was called.
 *   debugged: a tool failed, then a file was edited successfully (a bug found and fixed)
 *   told:     the user's message states something lasting ("以后…", "from now on…")
 */
export function noteNudge(messages: Message[]): NudgeReason | undefined {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role !== "user") start--;
	if (start === 0) return undefined;
	const user = messages[start - 1];
	const run = messages.slice(start);
	if (run.some((m) => m.role === "custom" && m.customType === NUDGE_TYPE)) return undefined;
	if (run.some((m) => m.role === "assistant" && parts(m).some((p) => p.type === "toolCall" && p.name === "kb_note"))) return undefined;

	// Bash calls whose command changes files, so a fix made with sed or a script counts too.
	const shellEdits = new Set(
		run.flatMap((m) =>
			m.role === "assistant"
				? parts(m).filter((p) => p.type === "toolCall" && p.name === "bash" && typeof p.arguments?.command === "string" && shellWrites(p.arguments.command)).map((p) => p.id)
				: [],
		),
	);
	let failed = false;
	for (const m of run) {
		if (m.role !== "toolResult") continue;
		if (m.isError) failed = true;
		else if (failed && (EDIT_TOOLS.has(m.toolName ?? "") || shellEdits.has(m.toolCallId))) return "debugged";
	}
	return LASTING.test(text(user)) ? "told" : undefined;
}

/** The hidden message that asks for a note. Model-facing, so English. */
export function nudgeText(reason: NudgeReason): string {
	const what =
		reason === "debugged"
			? "You fixed a problem in this run. If its root cause was not obvious (a gotcha, a misleading error, a workaround), it is worth a note."
			: "The user told you something meant to last beyond this conversation. Unless it is already in the knowledge base, it is worth a note.";
	return [
		`[pi-kb] ${what}`,
		"If so, save it now with kb_note (check kb_search with scope wiki first and append to a related note). The user reviews it before it is saved.",
		"If there is nothing worth saving, end your turn without another message.",
	].join(" ");
}
