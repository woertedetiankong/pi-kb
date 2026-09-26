# pi-kb

[中文](README.md) · English

A personal knowledge base for [pi](https://pi.dev): add PDFs, images (scans included) and Markdown notes, and the agent searches them when it answers, citing the page. Switch it on and off at any time with `/kb on` / `/kb off`.

## Install

Requires Node.js 22.19+ and pi 0.87 or later. Used daily on macOS; the full test suite passes on Linux; Windows is supported but not yet tried on a real machine, so please open an issue if something breaks.

```bash
# Install from GitHub (written to ~/.pi/agent/settings.json, available in every project)
pi install git:github.com/woertedetiankong/pi-kb

# Or pin a version that does not follow the repository
pi install git:github.com/woertedetiankong/pi-kb@v0.5.11

# Or try it for this run only, without installing
pi -e git:github.com/woertedetiankong/pi-kb
```

Update: `pi update --extensions`, then restart pi (pinned installs are not updated; use `pi install …@new-version`). Uninstall: `pi remove git:github.com/woertedetiankong/pi-kb` (the knowledge base in `~/.pi/kb` is kept).

### Quick start

1. Restart pi after installing; the status bar shows `📚 KB · 0 docs`.
2. Import material: `/kb add ~/Documents/manual.pdf` (several files or whole folders at once; you can also drag files into the terminal), or run `/kb web` and drop files on the page. Imports run in the background while you keep chatting. The first time an image or scan is recognised, OCR language data is downloaded from GitHub (about 40 MB, once); the status bar says so.
3. Just ask, e.g. "What is the maximum supply voltage of the XR-100?". The agent searches the knowledge base first and cites sources like `[manual.pdf p.3]`.
4. On the web page you can also browse the converted text, get a cited answer with "✨ Ask AI" next to the search box, and turn on semantic search under Settings (plain-language questions, Chinese and English finding each other).

Developers can install from a local folder: `pi install /path/to/pi-kb`, or `pi -e ./src/index.ts` for one run.

Supported material: PDF, images (PNG / JPG etc., via OCR), Markdown and plain text. Word / PowerPoint / Excel are experimental: they need LibreOffice (`brew install --cask libreoffice`) and are not tested yet.

## Usage

Everyday commands (typing `/kb ` in pi completes only these; `/kb help` lists them all):

| Command | What it does |
|---|---|
| `/kb add <file or folder…> [--project\|--global]` | Import material in the background; the command returns at once and you can keep working. Dragging paths into the terminal works. In a project with its own knowledge base, choose which one it goes to |
| `/kb add <note.md…> --note` | Add as experience notes in the wiki |
| `/kb search <keywords>` | Search it yourself |
| `/kb web` | Open the knowledge base page in the browser (`/kb web url` prints the full address, `/kb web stop` closes it) |
| `/kb note [focus]` | Ask the agent to review this conversation and save what is worth keeping as wiki notes |
| `/kb list [words]` | List documents and notes (up to 50; add words to filter by title) |
| `/kb remove <title or id>` | Delete (a note's file is deleted too) |
| `/kb cancel` | Stop the import in progress (files already imported are kept) |
| `/kb` or `/kb status` | Show whether it is on and how much it holds |
| `/kb on` / `/kb off` | Turn on / off (saved). When off, the tools and the prompt section are removed and take no context |
| `/kb help` | List all commands |

More commands (project knowledge bases, search settings, upkeep; completed once you type their first letters):

| Command | What it does |
|---|---|
| `/kb init` | Create a project knowledge base in the project (`.pi/kb`, shared with the team through git); see below |
| `/kb move <title or id> [project\|global]` | Move a document or note to the project's or your global knowledge base (without a target: to the other one) |
| `/kb semantic [status\|api\|local\|off\|remove]` | Semantic search: show status, use an online API, use a local model, turn off, delete the local model (frees about 1.1 GB; documents and notes stay) |
| `/kb lint` | Check the wiki notes: likely duplicates, broken `[[links]]`, project notes linking to global ones (teammates can't open them), notes without tags |
| `/kb eval [init\|draft\|run]` | Measure retrieval: create the question file, let the agent draft questions, run the evaluation |
| `/kb open` | Open the knowledge base folder |
| `/kb lang zh\|en\|auto` | Switch the interface language |
| `/kb sync` | Re-read the folder now. Rarely needed: notes edited by hand and content from another computer or a teammate are picked up automatically |

The flags `pi --kb off` / `--kb on` apply to this run only.

## Semantic search (optional)

By default only keyword search is used. With semantic search on you can ask in plain language ("how many volts can the chip take at most" finds the page that says "absolute maximum rating 4.0V"), and Chinese and English find each other. Keyword and semantic results are merged by rank (RRF); results found only by meaning are marked "semantic", and the agent checks them with `kb_read` before citing.

Two ways, pick one. Turn it on with the commands below in pi, or on the web page (`/kb web`) under "Settings" in the sidebar, where you can also enter the endpoint and key and set mirrors. Both edit the same settings, and other pi windows follow within a few seconds:

| | Online API `/kb semantic api` | Local model `/kb semantic local` |
|---|---|---|
| Model | Any OpenAI-compatible `/embeddings` endpoint; default OpenAI `text-embedding-3-small` | `Qwen3-Embedding-0.6B` (Alibaba Qwen, Apache 2.0; strong in Chinese, English and across the two) |
| Install | Nothing extra | On first use, installs a runtime (about 500 MB) into `~/.pi/kb`, then downloads the model (about 610 MB, pinned to the tested revision) |
| Privacy | **The text of your documents and notes is sent to the provider** (you are asked to confirm when turning it on) | Everything stays on your machine |
| Cost | Billed by the provider | Free |

- Why Qwen3-Embedding-0.6B: three local models were compared on the same material (40+ English pi docs plus Chinese material, 502 chunks; 23 questions with known answers, including Chinese↔English; 8 questions the knowledge base cannot answer; Apple silicon Mac):

  | | Qwen3-Embedding-0.6B (chosen) | bge-m3 | Granite R2 311M |
  |---|---|---|---|
  | Right document first / in top 3 | **15 / 21** | 13 / 20 | 14 / 21 |
  | MRR | **0.794** | 0.737 | 0.768 |
  | Score gap between relevant and unrelated questions | **0.068** | 0.051 | 0.018 |
  | Indexing 502 chunks | 127 s | 87 s | 41 s |
  | Download | 614 MB | 570 MB | 313 MB |
  | License | Apache 2.0 | MIT | Apache 2.0 (tokenizer under Gemma terms) |

  The sample is small and the top two differ by one or two questions; Qwen3 won mainly because it best separates "has an answer" from "has no answer", and its license is the cleanest.
- For Qwen3, semantic results below a similarity of 0.43 are dropped by default (questions with an answer scored ≥ 0.46 for their best result, questions without one ≤ 0.39), so asking about something the knowledge base does not have returns nothing instead of a forced match. Adjust with `semantic.minScore` in `config.json`.
- Indexing uses about 2–3 GB of memory (2 chunks at a time; 8 at a time goes above 5 GB without being faster). A 300-page manual takes about 3–6 minutes, in the background; keyword search keeps working meanwhile. A query takes about 45 ms.
- The API key is read from, in order: the `PI_KB_EMBEDDING_API_KEY` environment variable → the key entered in `/kb semantic api` (stored in `config.json` with file mode 0600) → `OPENAI_API_KEY` when using OpenAI. Local services such as Ollama (`http://localhost…`) need no key.
- Other common online endpoints (enter the address and model in `/kb semantic api`):

  | Service | Endpoint | Model | Notes |
  |---|---|---|---|
  | OpenAI (default) | `https://api.openai.com/v1` | `text-embedding-3-small` | No default similarity floor yet; only the number of semantic-only results is limited |
  | SiliconFlow (international) | `https://api.siliconflow.com/v1` | e.g. `Qwen/Qwen3-Embedding-0.6B` or `BAAI/bge-m3` | Same models as the local option: queries get the instruction Qwen3 needs, and each uses its measured floor (0.43 / 0.51) |
  | SiliconFlow (mainland China) | `https://api.siliconflow.cn/v1` | same | For users in mainland China; may be unreachable from elsewhere |
  | Ollama (local) | `http://localhost:11434/v1` | e.g. `qwen3-embedding:0.6b` | No key; data stays on your machine |
- Imported material is searchable by keyword right away; vectors are built in the background with progress in the status bar (`🧠 120/600`, then `🧠` when done). Changing the model rebuilds them.
- If HuggingFace or npm is hard to reach (for example in mainland China): set `"hfEndpoint": "https://hf-mirror.com"` (model download) and `"npmRegistry": "https://registry.npmmirror.com"` (runtime install) under `semantic.local` in `config.json`, or under download sources in the web settings. Off by default; the official sources are used.

```json
"semantic": {
  "provider": "local",
  "api": { "baseUrl": "https://api.openai.com/v1", "model": "text-embedding-3-small" },
  "local": { "model": "onnx-community/Qwen3-Embedding-0.6B-ONNX" }
}
```

## Measuring retrieval

Measure whether the knowledge base actually finds the answers in your own material, or compare settings. Only retrieval is measured (was the right page found, at what rank); no model is called, nothing is billed, and it runs in seconds.

1. `/kb eval init` creates `~/.pi/kb/eval/questions.txt` (with instructions in Chinese and English), or `/kb eval draft` has the agent read your material and draft about 15 questions.
2. Write one question per line:

   ```
   芯片的最大供电电压是多少 | xr100-manual.pdf p.1
   how do I configure the SPI clock divider | xr100-manual.pdf p.2; SPI 时钟分频踩坑
   what's for lunch today | -
   ```

   Right of the bar is where the answer is (part of a file name or note title, optionally with a page; separate several acceptable answers with `;`); `-` means the knowledge base has no answer. Phrase questions the way customers really ask, not copied from the text.
3. Run `/kb eval`. The terminal shows a summary, and `~/.pi/kb/eval/reports/` keeps a per-question report (rank in each mode, and what came first). Inside a project with its own knowledge base, the project and your global one are searched together, as the agent does.

With semantic search on, three modes are compared: keyword only, keyword + semantic (what the agent uses), and semantic only.

Example results (pi docs + Chinese material, 502 chunks; 29 answerable questions, 6 of them exact terms like `CTRL_REG` or `setActiveTools`; 14 unanswerable, 6 of them like "docker interview questions" where one word is in the knowledge base and the other is not; local Qwen3):

| Mode | Hit at 1 | Hit in top 3 | Hit in top 8 | MRR | Empty when no answer |
|---|---|---|---|---|---|
| Keyword | 34% | 34% | 45% | 0.36 | 100% |
| Keyword + semantic | 69% | 90% | 97% | 0.80 | 71% |
| Semantic only | 69% | 86% | 97% | 0.79 | 71% |

The unanswerable questions that still returned results all came from semantic search: "docker interview questions" finds documents about Docker (on topic, but no interview questions). Such results are marked "semantic", and the agent checks them before citing.

This question set is mostly natural language and cross-language, which is hard for keyword search; if customers mostly ask with part numbers and register names, keyword search does much better. The fusion method was chosen with this evaluation too: weighting keyword results by term coverage or giving semantic results more weight both broke exact-term queries, so standard RRF stayed.

## Project knowledge bases and team sharing

Each project can have its own knowledge base in `.pi/kb` (next to pi's own project settings in `.pi/`), shared with the team through git.

```bash
/kb init        # once, in the project: creates .pi/kb at the top of the git repository
git add .pi/kb && git commit -m "Project knowledge base"
```

- **Searches cover this project and your global knowledge base**, marking hits [project] or [global]; other projects never show up. It is found from any subfolder of the project.
- **Imports and notes go to the project by default**: files from inside the project go to it, files from anywhere else (say `~/Downloads`) to your global one, so a personal or vendor file does not end up in the team's repository by accident; `/kb add --project` or `--global` decides for you, and the web page has a "New material goes to: project / global" switch. When recording a lesson the agent decides: things that only concern this project (build and flashing steps, wiring, team conventions) go to the project, reusable knowledge (chips, tools) and personal preferences to your global one; the save dialog can switch it with one choice.
- **Misplaced? Move it**: `/kb move <title or id>` (moves it to the other one), or "Move to project / Move to global" on the page.
- **Committed**: notes, converted text (2-7% of the PDFs' size) and document descriptions. **Not committed**: originals and the local change log (see the generated `.pi/kb/.gitignore`; delete its `raw/` line to share originals too).
- Teammates who pull the code get an index built when pi starts, and can search, ask AI and read the text with page numbers; "Open original" needs the original file. Later pulls show up by themselves: pi notices changed files in `.pi/kb` (within a few seconds) and indexes them before the next search.
- The project knowledge base is committed: keep secrets out of it, and check the copyright before putting vendor documents' full text in a public repository.

## Web page

`/kb web` opens a local page (listening on `127.0.0.1` only, access token required):

- Drop files on the page to import them: the left half as documents, the right half (Markdown) as experience notes. They go through the same background queue as `/kb add`, with progress on the page; imports started in the terminal show their progress there too
- Search results show pages and open right at that page; for PDFs, "View page" opens the original at that page in the browser
- "✨ Ask AI" answers the question in the search box from the knowledge base, with pi's current model or one picked next to the button (remembered in the browser; a cheap, fast model is usually enough): the model first turns it into a few searches (including the other language and the wording a manual would use), then answers only from the passages found, citing each fact as [1]; a citation opens the original at that page. When the documents do not cover the question, it says so instead of guessing. Each question makes two model calls (about 1-2 thousand tokens)
- Browse the converted text (tables and headings rendered as Markdown), create and edit notes, delete, and turn the knowledge base on or off
- `[[links]]` in notes open the linked note (missing ones are struck through); click a tag, or one under "Tags" in the sidebar, to see the notes with that tag
- With semantic search off, a search with few results says why: only the exact words match, so Chinese does not find English material
- 中文 / English switch; add `?lang=en` or `?lang=zh` to a link to choose the language, `?q=<keywords>` to search directly, `?doc=<id>&page=<n>` to open a page of a document

The page is served by the shared pi-web server (`src/hub.ts`). When [pi-sessions](https://github.com/woertedetiankong/pi-newsession) and [pi-learn](https://github.com/woertedetiankong/pi-learn) are installed too, they live under one address (`/sessions/`, `/kb/`, `/learn/`) with a switcher at the top, sharing the access token in `~/.pi/agent/pi-web/token`. After `/reload` the server comes back at the same address, so open pages keep working. `src/hub.ts` must stay identical in all three repositories.

## Interface language

The interface (status bar, messages, lists, the note confirmation, the request sent by `/kb note`) is available in Chinese and English, chosen in this order:

1. The `PI_KB_LANG=zh|en` environment variable
2. The setting saved by `/kb lang zh|en` (`language` in `config.json`)
3. `auto` (default): `LC_ALL`, `LC_MESSAGES`, `LANG` (ignoring `C` / `POSIX`), then the macOS system language, then Node's locale; English if none is recognized

Tool descriptions and the system prompt the model sees are always English: models follow English instructions most reliably, and the answer still follows the user's language.

When on, the agent has four tools:

- `kb_search`: keyword search, returning citations like `[manual.pdf p.12]` and document ids
- `kb_read`: read the original text by id and pages (e.g. `pages: "12-14"`). With `view: true` it also returns pictures of up to 4 pages, rendered from the original PDF, image or Office file, so the model can see diagrams, schematics, pinouts and table layout that the text loses. Only for models that accept images, and only where the original is present (project knowledge bases leave originals out of git by default). When a page's text came from OCR (a scan or photo, or text read from a figure), `kb_read` says so at the top and suggests viewing the page before relying on exact values
- `kb_add`: import files when the user asks to "put this in the knowledge base". Files outside the current project folder (including through symlinks) need your confirmation first; without a UI they are refused, so use `/kb add` yourself. This keeps instructions hidden in a document or web page from making the agent file away something like `~/.ssh`, or send it to an online embeddings service
- `kb_note`: write experience as a wiki note. The agent calls it on its own after solving a non-obvious problem (a root cause found by debugging, a gotcha, a workaround) or learning something lasting about your setup; every note is previewed first and you choose **Save / Edit, then save / Don't save**. A note with the same title is not duplicated but extended (`append`) or rewritten (`replace`)

  Some models rarely take notes on their own (gpt-6-luna in our checks stops as soon as a bug is fixed). So before a run ends, the extension checks for two cases: a command failed and a file was then changed (a bug was fixed), or you said something like "from now on…" or "remember…". If the model did not call `kb_note`, the extension adds a hidden reminder asking whether to save a note. It asks at most once per run; routine edits and questions do not trigger it. Small fixes, such as a typo that fails a test, do trigger it; in 3 runs each with gpt-6-sol and gpt-6-luna the model judged them not worth a note and ended without another message, at the cost of one short extra model call (about $0.001).

## Experience note format

```markdown
---
title: "XR-100 Flash reads wrong: set the SPI divider first"
tags: [spi, xr100]
created: 2026-09-24
updated: 2026-09-24
project: "firmware"
---

# XR-100 Flash reads wrong: set the SPI divider first

Symptom / root cause / fix / how to recognize it next time
```

Appending to a note adds a dated section: if the new content opens with its own heading, that heading stays with the date on the line below; otherwise the date is the heading.

**No duplicate notes**: before a new note is saved, similar existing notes are looked up: alike titles (such as "XR100 SPI clock divider" and "XR-100 SPI divider") and notes a search for the new title finds. With semantic search on, Chinese and English notes recognise each other (only with a model that has a similarity floor, such as the local Qwen3; otherwise the closest notes would be listed whether related or not). The save dialog in the terminal lists them and adds "Add to … instead", which shows the combined note before saving; a new note on the web page lists them first, so you can open one and add to it, or "Save as new anyway". `/kb lint` checks the whole wiki at any time.

Notes link to each other with `[[file name]]`, `[[subfolder/file name]]` or `[[note title]]` (also `[[target|label]]` and `[[target#section]]`), as in Obsidian.

Hand-written notes (front matter optional) placed in `wiki/` are indexed too. Each write appends a line to `wiki/log.md`. The index holds the body and `#tags`, not front matter field names.

A small catalog (counts, wiki note titles, recent documents) is added to the system prompt so the agent knows what the knowledge base holds.

## Storage

`~/.pi/kb` by default, all plain files, in two parts:

```
# Content: documents and notes (can move, and can be synced between computers)
raw/<id>/<original file>  copy of the original
converted/<id>.md         converted Markdown with <!-- kb:page N --> page markers (and <!-- kb:ocr n/total --> where text came from OCR)
docs/<id>.json            each document's description (title, source, pages); the index is rebuilt from it
wiki/**/*.md              experience notes; edit them with Obsidian or any editor

# This machine: always stays in ~/.pi/kb
kb.db                     search index (SQLite FTS5, trigram tokenizer, Chinese and English) and semantic vectors;
                          indexes/<key>/kb.db when the content lives elsewhere. It is a cache: delete it and it is rebuilt
config.json               { "enabled", "language", "ocrLanguage", "ocrServerUrl", "semantic", "dataDir", "tips" }
tessdata/                 OCR language data (downloaded on first OCR)
runtime/, models/         runtime and model files for local semantic search (only after /kb semantic local; /kb semantic remove deletes them)
```

**Moving it**: your documents and notes can live in any folder. On the web page, Settings → Storage location takes a folder and can copy the current documents there; other pi windows follow. Choose a folder in iCloud or Dropbox and point several computers at it to share one knowledge base: documents and notes added on one computer become searchable on another within seconds (pi notices the changed files at the next search or page load and indexes them).

The "this machine" part above stays behind, each for its own reason:

- **Settings**: where the knowledge base lives is itself stored in `config.json`, and pi reads it at startup to find your documents, so it has to be in a fixed place. It also holds the API key, which does not belong in a cloud folder.
- **Search index**: a cache built from your documents, not your data; each computer rebuilds its own. In a synced folder it would be at risk: two computers writing the same SQLite file while the sync tool copies it half-written can corrupt it.
- **Models and OCR data**: large (the local model is about 1.1 GB) and can be downloaded again at any time, so not worth syncing.

To keep everything in one folder, index and models included (on an external disk, say), set the `PI_KB_DIR` environment variable. The page then cannot change the location, and that folder should not be a synced one.

## Importing

- `/kb add` queues the files and returns at once; they are processed one by one in the background with progress in the status bar (`📥 2/5 manual.pdf 3:12`) and a summary when all are done. Each file is searchable as soon as it is done.
- Parsing runs in a separate process, so pi stays responsive and Tesseract's debug output does not scribble over the terminal. `/kb cancel` stops the current file right away.
- Rough speed (Apple silicon Mac): a 162-page datasheet takes about 1.5 minutes, a 1530-page technical reference manual about 14 minutes.
- When the agent imports with `kb_add`, it waits up to 30 seconds; if the import is not done by then it tells you it is importing in the background, and you are notified when it finishes.
- **Same file names**: files with the same name in different folders (say, several `README.md`) get titles with enough of the folder path to tell them apart, such as `[project-3/README.md]` and `[project-17/README.md]`, so citations are unambiguous. A unique file name stays as it is. Uploads from the web page have no folder, so a repeated name is numbered: `README.md (2)`.
- **New versions**: importing a file from the same path again (for web uploads, the same file name) with changed content asks first: **Replace the old version / Keep both / Cancel import**. A replacement keeps the old title, so earlier citations still fit, and the old original and index are deleted. Unchanged files simply show as already present, without asking. An upload with the same name still waiting in the import queue counts as an earlier version too, and which versions a replacement removes is decided when it is imported, so uploading several versions in a row ends with just the newest when you choose Replace.

## Parsing and search

- Parsing uses [LiteParse](https://github.com/run-llama/liteparse): PDFs become Markdown with headings and tables, keeping physical page numbers; images and scanned pages go through Tesseract OCR (`eng+chi_sim` by default). The Chinese model makes OCR about 4x slower, so a PDF whose own text has no Chinese is OCR'd with the other languages only (a 162-page English datasheet: about 2 minutes instead of 7½); scans and images, which have no text to judge by, get every language.
- Search uses Node's built-in `node:sqlite` with FTS5 trigram, so there are no native dependencies. Terms of 3+ characters use the index, 1–2 character terms (such as 电压) use LIKE; long Chinese sentences are split into trigrams for fuzzy matching, ranked by term coverage plus BM25.
- English function words like how / the, Chinese question words like 怎么、如何、什么, and lone Chinese characters (such as 用) are ignored.
- With several terms, more than half must match: with two terms both must appear, unless the other term is on another page of the same document (so "Python 列表排序" does not match a page just because it mentions Python).
- English matches at word starts (`compact` matches `compaction`, `pi` does not match `api`), and plurals match singulars (`shortcuts` → `shortcut`).
- On import, spaces OCR inserts between Chinese characters and Markdown escapes (`CTRL\_REG` → `CTRL_REG`) are removed so the original terms can be found.

### Known limitations

- Tesseract is mediocre on Chinese scans: word order within a line can be scrambled. For many scans, configure a PaddleOCR server: enter its address as the OCR server in the web page's Settings, or set `"ocrServerUrl"` (LiteParse's OCR HTTP interface) in `config.json`. The OCR languages can be changed there too; changes apply to the next import without restarting pi. With a model that accepts images this matters less: OCR only has to be good enough to find the page, and the agent is told to view OCR'd pages before quoting exact values.
- Vector search always returns the "closest" chunks, even when nothing is relevant: semantic-only results are capped in number and marked separately; the tested models (Qwen3-0.6B, bge-m3) also have a similarity floor, other models (such as OpenAI) only the cap for now.
- The floors were measured on the material above (Qwen3 has a margin of about 0.03–0.04 on each side); for very different material you may need to tune `semantic.minScore`.
- Quitting pi, `/reload`, `/new` or `/resume` pauses an import in progress: files already imported are kept, and the rest are recorded in `~/.pi/kb/pending-imports/` on this computer and imported when pi next starts (web uploads are copied first). The file that was being converted starts over. Files bound for a project knowledge base wait until pi starts in that project. Non-interactive runs such as `pi -p` leave them alone.

## Development

```bash
npm install
npm run typecheck
npm test
```

### Model checking

`specs/tla` has TLA+ models of the import queue with version replacement (`ImportVersions.tla`) and of background embedding (`SemanticIndexer.tla`), with configs for the code before and after the race fixes in the changelog. `test/concurrency.test.ts` replays the counterexamples on the real code. To run a model you need Java and [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases):

```bash
JAVA=java TLA2TOOLS=/path/to/tla2tools.jar specs/tla/run.sh ImportVersions ImportVersions_FixBase
```

### Checking with a real model

Unit tests do not call a model. To see whether a model actually uses the knowledge base on its own, run:

```bash
node scripts/model-check/run.ts                      # default openai-codex/gpt-6-luna, 17 scenarios, 2 runs each
node scripts/model-check/run.ts --model <provider/id> --runs 5 --only debug-note,missing
node scripts/model-check/run.ts --installed               # with all your installed extensions and skills (pi-kb must be installed)
```

Each run gets a fresh copy of a fictional knowledge base (XR-100 chip manual, an XR-100 board outline drawing, Orbit deploy runbook, YF-20 printer FAQ, one SPI lesson note, plus a few unrelated documents) and runs `pi -p --mode json` in an empty project folder with only this extension loaded; your `~/.pi/kb` is not touched. The scenarios are in `scripts/model-check/scenarios.ts` and check:

- `kb_search` is called when the documents may hold the answer (Chinese, English, across languages, a symptom with no mention of documents), and general programming questions get no citations
- `kb_note` is called after debugging a non-obvious root cause or learning a fact about the user's setup; an existing related note is extended with `append`; routine edits and lookups are not noted
- Citations match what `kb_search` / `kb_read` printed exactly (`[xr100-manual.pdf p.1]`), and the answer says so first when the documents do not answer directly
- When the answer is only in a picture, the page is viewed with `kb_read` `view: true`: the board outline drawing (`xr100-outline.pdf`, generated by `xr100-outline.ts` next to it) has its dimensions drawn as lines, and OCR reads only some of them, so the vertical ones (38, 30) can only be read off the page

It calls the model for real and is billed (17 × 2 runs take a few minutes). Every run's result and full answer go to `report.md` in the output folder.

Results with gpt-5.5 (2026-09-24): it searched whenever it should and invented no citations; it saved a note after debugging 8/8 times, used `append` for an existing note, and did not note routine work. Still uneven: asked "does the XR-100 support USB-C power?" (not in the documents), it said the manual doesn't mention it first in about 5 of 8 runs; otherwise it went straight to a conclusion inferred from the voltage range.

Results with gpt-6-luna (2026-09-24, 3 runs per scenario): 34/36 in the end. Before the changes it often searched with `scope: "docs"`, which left out wiki notes; put section names inside citations; saved a note after debugging 0/3 times; and twice told the user it would remember something it never saved. The current system prompt, the `scope` description and the reminder above fixed these: notes after debugging 3/3, setup facts 3/3, no false reminders in routine scenarios.

Results with gpt-6-sol (2026-09-24, 3 runs per scenario, with the current prompt and reminder): 36/36. It saved notes after debugging and after hearing setup facts without needing the reminder, and appended only new content. Once it appended the production Flash model to the SPI divider note, which works, though a separate note would fit better.

Again with gpt-6-sol after v0.5.2 (2026-09-25, 3 runs per scenario, plus a new scenario that adds a detail in English while the existing note is in Chinese): 48/48. In all 3 English runs it found the Chinese note and appended to it instead of starting an English one; every scenario searched before writing and no duplicate note was created, so the "similar notes already exist" message never came up. The production Flash model again went into the SPI divider note in 1 of 3 runs; the save dialog in the terminal shows this, so you can change it.

With page viewing (v0.5.4, 2026-09-26, gpt-6-sol, 3 runs each of the drawing scenario and the three other XR-100 scenarios): 12/12. For the drawing it searched, then viewed page 1 every time and read all four dimensions correctly; adding the drawing to the knowledge base did not change the other XR-100 answers. On M5Stack's StickS3 documents it also viewed a dimension drawing by itself when no text held the answer, and used the text when it did.

Alongside pi-robot (2026-09-25, gpt-6-sol, `--installed`, 3 runs per scenario): pi-robot's pi-embedded-docs has its own `document_*` tools (import, search, read, view pages), scoped to the current session and folder. They did not get in each other's way: questions about the knowledge base used `kb_search` all 27 times; "save this to the knowledge base" used `kb_add`, not `document_import`; a question about a PDF in the project checked the knowledge base, then read the PDF with `document_*`, without filing it away. The one problem was the note reminder: a fix made through pi-robot's `code` tool (Python) was not recognised at first; it is now.

## License

MIT
