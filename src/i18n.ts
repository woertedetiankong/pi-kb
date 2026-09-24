import { parseLanguage, systemLanguage } from "./hub.ts";

/**
 * User-facing text only. Tool descriptions, the system prompt section and tool
 * results stay in English: models follow English instructions most reliably and
 * already answer in the user's language.
 */

export type Language = "en" | "zh";
export type LanguageSetting = Language | "auto";

const en = {
	statusOn: (docs: number, notes: number) => `📚 KB · ${docs} docs · ${notes} notes`,
	statusOff: "📚 KB off",
	importing: (i: number, n: number, name: string) => `📚 importing ${i}/${n} ${name}`,
	enabled: "Knowledge base enabled",
	disabled: "Knowledge base disabled",
	status: (on: boolean, docs: number, pages: number, notes: number, root: string) =>
		`Knowledge base ${on ? "on" : "off"} · ${docs} docs (${pages} pages) · ${notes} wiki notes · ${root}`,
	usageAdd: "Usage: /kb add <file or folder…> [--note]",
	importTitle: "📚 Knowledge base import",
	addSummary: (added: number, exists: number, skipped: number, failed: number) =>
		`Added ${added}, already present ${exists}, skipped ${skipped}, failed ${failed}.`,
	addStatus: { added: "added", exists: "already present", skipped: "skipped", failed: "failed" },
	pages: (n: number) => `${n} pages`,
	reasons: {
		not_found: "not found",
		unsupported: (ext: string) => `unsupported type ${ext}`,
		no_text: "no text could be extracted",
		not_markdown: "only Markdown files can become wiki notes",
		needs_libreoffice: "Office files need LibreOffice: brew install --cask libreoffice",
	},
	listTitle: (n: number) => `📚 Knowledge base · ${n} item(s)`,
	listEmpty: "Empty. Add files with /kb add <path>, or put Markdown notes in the wiki folder (/kb open).",
	kinds: { pdf: "pdf", office: "office", image: "image", text: "text", note: "note" } as Record<string, string>,
	usageSearch: "Usage: /kb search <query>",
	searchTitle: (n: number, q: string) => `📚 ${n} result(s) for "${q}"`,
	noMatches: "No matches.",
	wikiNote: "wiki note",
	usageRemove: "Usage: /kb remove <id> (see /kb list)",
	removeTitle: (title: string) => `Remove ${title}?`,
	removeNote: "This deletes the note file.",
	removeDoc: "This deletes its stored copy.",
	removed: (title: string) => `Removed ${title}`,
	noteNeedsOn: "The knowledge base is off. Turn it on with /kb on",
	noteRequest:
		"Review this conversation and save what is worth keeping to my knowledge base with kb_note: lessons learned, root causes and their fixes, gotchas, decisions with their reasons, or my preferences. Search existing wiki notes first and append to a matching note instead of creating a near-duplicate. Skip routine work; if nothing is worth saving, just say so. Write in the language of our conversation.",
	noteFocus: (focus: string) => `Focus on: ${focus}`,
	noteNew: "New note",
	noteAppend: (title: string) => `Append to ${title}`,
	noteReplace: (title: string) => `Replace ${title}`,
	noteAsk: (title: string) => `Save to knowledge base: ${title}`,
	noteChoices: ["Save", "Edit, then save", "Don't save"] as [save: string, edit: string, skip: string],
	noteEditor: "Edit note",
	synced: (updated: number, removed: number) => `Wiki synced: ${updated} updated, ${removed} removed`,
	folder: (root: string) => `Knowledge base folder: ${root}`,
	unknown: (sub: string, subs: string) => `Unknown subcommand "${sub}". Try: ${subs}`,
	language: (lang: string, setting: LanguageSetting) =>
		`Language: ${lang === "zh" ? "中文" : "English"}${setting === "auto" ? " (auto)" : ""}. Use /kb lang zh | en | auto`,
	usageLang: "Usage: /kb lang zh | en | auto",
	webOpened: (url: string) => `Knowledge base opened in the browser: ${url} (/kb web url for the full link, /kb web stop to close)`,
	webUrl: (url: string) => `Knowledge base page (includes the access token, do not share): ${url}`,
	webStopped: "Web page closed (other pages in the same pi web app close too)",
	subcommands: {
		on: "Enable the knowledge base",
		off: "Disable the knowledge base (removes its tools and prompt)",
		status: "Show what the knowledge base holds",
		add: "Import files or folders: /kb add <path…> [--note]",
		list: "List documents and wiki notes",
		search: "Search the knowledge base: /kb search <query>",
		note: "Save lessons from this conversation as wiki notes: /kb note [focus]",
		remove: "Remove a document or note: /kb remove <id>",
		sync: "Re-index the wiki folder after editing notes by hand",
		open: "Open the knowledge base folder",
		web: "Open the knowledge base in the browser: /kb web [url | stop]",
		lang: "Interface language: /kb lang zh | en | auto",
	} as Record<string, string>,
};

export type Messages = typeof en;

const zh: Messages = {
	statusOn: (docs, notes) => `📚 知识库 · ${docs} 份文档 · ${notes} 条笔记`,
	statusOff: "📚 知识库已关闭",
	importing: (i, n, name) => `📚 正在导入 ${i}/${n} ${name}`,
	enabled: "知识库已开启",
	disabled: "知识库已关闭",
	status: (on, docs, pages, notes, root) =>
		`知识库${on ? "已开启" : "已关闭"} · ${docs} 份文档（${pages} 页）· ${notes} 条 wiki 笔记 · ${root}`,
	usageAdd: "用法：/kb add <文件或文件夹…> [--note]",
	importTitle: "📚 知识库导入",
	addSummary: (added, exists, skipped, failed) => `新增 ${added}，已存在 ${exists}，跳过 ${skipped}，失败 ${failed}。`,
	addStatus: { added: "新增", exists: "已存在", skipped: "跳过", failed: "失败" },
	pages: (n) => `${n} 页`,
	reasons: {
		not_found: "文件不存在",
		unsupported: (ext) => `不支持的文件类型 ${ext}`,
		no_text: "没有提取到文字",
		not_markdown: "只有 Markdown 文件可以作为 wiki 笔记",
		needs_libreoffice: "Office 文件需要安装 LibreOffice：brew install --cask libreoffice",
	},
	listTitle: (n) => `📚 知识库 · 共 ${n} 项`,
	listEmpty: "知识库是空的。用 /kb add <路径> 导入文件，或把 Markdown 笔记放进 wiki 文件夹（/kb open）。",
	kinds: { pdf: "PDF", office: "文档", image: "图片", text: "文本", note: "笔记" },
	usageSearch: "用法：/kb search <关键词>",
	searchTitle: (n, q) => `📚 “${q}” 共 ${n} 条结果`,
	noMatches: "没有找到匹配内容。",
	wikiNote: "wiki 笔记",
	usageRemove: "用法：/kb remove <id>（id 见 /kb list）",
	removeTitle: (title) => `删除 ${title}？`,
	removeNote: "会同时删除这条笔记的文件。",
	removeDoc: "会同时删除知识库里保存的副本。",
	removed: (title) => `已删除 ${title}`,
	noteNeedsOn: "知识库已关闭，请先用 /kb on 开启",
	noteRequest:
		"请回顾这次对话，用 kb_note 把值得长期保留的内容存进我的知识库：得到的经验、问题根因和修复方法、踩过的坑、做出的决定及原因，或者我的偏好。先搜索已有的 wiki 笔记，有相关笔记就追加，不要新建重复的笔记。日常琐事不用记；如果没有值得保存的内容，直接告诉我。用我们对话所用的语言来写。",
	noteFocus: (focus) => `重点：${focus}`,
	noteNew: "新笔记",
	noteAppend: (title) => `追加到 ${title}`,
	noteReplace: (title) => `改写 ${title}`,
	noteAsk: (title) => `保存到知识库：${title}`,
	noteChoices: ["保存", "编辑后保存", "不保存"],
	noteEditor: "编辑笔记",
	synced: (updated, removed) => `Wiki 已同步：更新 ${updated} 条，移除 ${removed} 条`,
	folder: (root) => `知识库文件夹：${root}`,
	unknown: (sub, subs) => `未知子命令 "${sub}"。可用：${subs}`,
	language: (lang, setting) =>
		`界面语言：${lang === "zh" ? "中文" : "English"}${setting === "auto" ? "（自动）" : ""}。切换：/kb lang zh | en | auto`,
	usageLang: "用法：/kb lang zh | en | auto",
	webOpened: (url) => `知识库已在浏览器中打开：${url}（/kb web url 查看完整地址，/kb web stop 关闭）`,
	webUrl: (url) => `知识库网页地址（含访问令牌，勿分享）：${url}`,
	webStopped: "网页已关闭（同一网页里的其他插件页面也一并关闭）",
	subcommands: {
		on: "开启知识库",
		off: "关闭知识库（移除相关工具和提示词）",
		status: "查看知识库状态",
		add: "导入文件或文件夹：/kb add <路径…> [--note]",
		list: "列出文档和 wiki 笔记",
		search: "搜索知识库：/kb search <关键词>",
		note: "把本次对话的经验存为 wiki 笔记：/kb note [重点]",
		remove: "删除文档或笔记：/kb remove <id>",
		sync: "手动编辑笔记后重建 wiki 索引",
		open: "打开知识库文件夹",
		web: "在浏览器中打开知识库：/kb web [url | stop]",
		lang: "界面语言：/kb lang zh | en | auto",
	},
};

const MESSAGES: Record<Language, Messages> = { en, zh };

export function messages(language: Language): Messages {
	return MESSAGES[language];
}

export { parseLanguage };

/** PI_KB_LANG, then the saved setting, then the system language. */
export function resolveLanguage(setting: LanguageSetting | undefined): Language {
	return parseLanguage(process.env.PI_KB_LANG) ?? (setting && setting !== "auto" ? setting : systemLanguage());
}
