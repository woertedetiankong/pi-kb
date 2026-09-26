# Changelog

## v0.5.4 — 2026-09-26

- `kb_read` can show pages as pictures: with `view: true` it renders up to 4 pages from the original (PDF, image, Office) at 150 dpi, so the model sees figures, schematics, pinouts and table layout that the converted text loses. The system prompt tells the agent to look when the answer may be in a figure; models that don't accept images get neither the hint nor the pictures. If a page can't be shown (no original, a text document, too many pages), the text is still returned with the reason.

## v0.5.3 — 2026-09-25

- Appending to a hand-written note that has no front matter gave it a `created` date in UTC, which in the evening in the US is a day after its `updated` date; both are now local dates.
- `scripts/model-check` has a scenario that adds a detail in English while the existing note is in Chinese (it should be appended, not written as a second note).

## v0.5.2 — 2026-09-25

### Keeping the wiki tidy

- New notes are checked against existing ones first: titles that are alike ("XR100 SPI clock divider" next to "XR-100 SPI divider") and notes a search for the new title finds, Chinese and English across each other when semantic search is on (only with a model that has a similarity floor, such as the local Qwen3). The terminal's save dialog lists them and offers "Add to … instead", which appends the lesson as a section of that note and shows the result before saving. The web page's "New note" lists them first, with "Save as new anyway". Without a UI the agent is told about them.
- `/kb lint` checks the wiki: likely duplicates (alike titles, or notes that semantic search finds first for each other's title), `[[links]]` to notes that don't exist, project notes linking to your global notes (teammates can't open them), and notes without tags.
- `[[links]]` between notes open the linked note on the web page, by file name, path or title (`[[target|label]]` and `[[target#section]]` too); missing ones are struck through.
- Tags on the web page are clickable, and the sidebar lists the most used ones: click one to see the notes with that tag.

### Web page and messages

- With semantic search off, a search that finds little says why (only the exact words match, so Chinese does not find English material) and links to Settings.
- A note no longer shows its title twice.
- The web page shows "first OCR: downloading language data" again during the first OCR import; a text key used twice on the page had hidden it since v0.3.1. A test now checks the page's texts for keys defined twice.
- English counts read naturally: "1 doc · 1 note", "1 page", "2 files" instead of "1 docs", "file(s)".
- The README's command table lists `/kb init`, `/kb move`, `/kb lint` and `--project` / `--global`.

## v0.5.1 — 2026-09-25

- In a project with its own knowledge base, `/kb add` and the agent's `kb_add` put files from outside the project (say `~/Downloads/vendor.pdf`) into your global knowledge base unless you ask for the project with `--project` (or `scope: "project"`), so they are not committed for the team by accident. Files inside the project still go to the project; the message says where each went.
- The agent is no longer told the knowledge base holds Office documents; supported material is PDF, images, Markdown and text (Office stays experimental).
- Teammates' notes and documents arrive with `git pull` and are searchable without restarting pi or `/kb sync`: pi notices changed files in `.pi/kb` (looking at file sizes and times, at most every 2 seconds) and indexes them before the next search.
- `/kb eval` inside a project measures what the agent searches, the project and your global knowledge base together; before, the project's material was left out. Without a project, results are unchanged (the old and new search returned identical hits in 60 comparisons).
- A note's `project:` field names the project (its git repository), not the subfolder pi was started in.
- A project note and a global note with the same file name (say both `wiki/xr-100-spi.md`) had the same id, so the global one could not be read, edited, removed or moved: everything reached the project's. Project notes now get ids of their own (they change once, on the first start after updating; nothing to do).
- A document already in one knowledge base is no longer imported into the other (the two copies would share an id); the import says where it is, and `/kb move` or "Move to project" shares it with the team.
- Moving a note keeps its `created` and `updated` dates and its `project:` field; before, they were reset to the day of the move. Moving a note where one with the same title exists says so, instead of suggesting a tool option.

## v0.5.0 — 2026-09-25

### Project knowledge bases, shared with the team

- `/kb init` creates a knowledge base in the project's `.pi/kb`, committed to git with the code. Searches (the agent's, the page's and Ask AI's) cover it and your global knowledge base together and mark each hit [project] or [global]; other projects never show up.
- Imports and new notes go to the project by default (`/kb add --global`, and a switch on the page, for the global one). The agent decides where a lesson belongs: project-only knowledge to the project, reusable knowledge and personal preferences to the global one; the save dialog can switch it. Checked in pi with gpt-6-sol: a board's wiring went to the project, a personal tool preference to the global knowledge base, and a teammate who pulled the repository got the first but not the second.
- `/kb move <id> project|global` and "Move to project / global" on the page, for notes and documents (also without their original file).
- The generated `.gitignore` keeps originals and the change log out of git; teammates' pi builds its own index from the committed text.
- Both knowledge bases share one local semantic model in memory.

## v0.4.0 — 2026-09-25

### Choose where the knowledge base lives

- Content and index are separate. Documents and notes (`raw/`, `converted/`, `wiki/`, and a new `docs/<id>.json` per document) are plain files; the SQLite index is a cache on this machine, rebuilt from the files when it is missing or when another computer changed them. Existing knowledge bases get their `docs/` descriptions on the first start, with nothing to do. An index rebuilt from the files matched the original exactly on real datasheets (193 chunks, same ranks for 8 searches).
- Settings → Location on the web page moves the content to any folder, e.g. in iCloud or Dropbox, optionally copying what is there; other pi windows follow within seconds. Several computers pointed at the same synced folder share one knowledge base, each with its own index, so the sync never touches SQLite. Config, index, OCR data and models stay in `~/.pi/kb`. `PI_KB_DIR` still puts everything in one folder.
- "Sync with the folder" (`/kb sync`) now picks up documents too, not only wiki notes. Note ids use `/` on every system, so a folder shared between Windows and macOS gives the same ids.

## v0.3.1 — 2026-09-25

- Asking while files are still importing no longer gets "the knowledge base has nothing on this": `kb_search` tells the agent which files are still being imported, and it says so (checked with gpt-6-sol in pi).
- The first OCR says why it takes long: the status bar and the web page show "downloading language data (about 40 MB, once)" while Tesseract data comes from GitHub.
- When OCR language data cannot be downloaded, an image or scan fails with a clear reason instead of being "added" with no text; nothing is stored, so importing it again later works. Before, the empty copy blocked re-imports as "already present".
- Windows: `/kb add C:\Users\…\manual.pdf` keeps its backslashes (they were read as escapes), `/kb web`, `/kb open` and `/kb eval init` open with the system's default app on every platform (Windows got a malformed `start` title before; `/kb open` was macOS-only), and the LibreOffice hint names winget or apt instead of brew.
- README: install from GitHub, update, uninstall, and a quick start.

## v0.3.0 — 2026-09-25

### Ask the knowledge base on the web page

- "✨ Ask AI" on the web page answers a question from the knowledge base and cites each fact [n], with pi's current model or one picked next to the button (same choice as on the sessions and learn pages: follow pi, or a fixed model remembered in the browser); citations open the source at its page. The model plans a few searches first (other language, a manual's wording, the bare product name), then answers only from what they found and says so when the documents do not cover the question. On the fictional test corpus gpt-6-sol answered 13 of 13 questions correctly, including three the documents do not cover and one unrelated question (no model call when nothing is found).

### Settings on the web page

- The web page has a Settings dialog. Semantic search: it switches between off, the local model and an online API, takes the endpoint, model and key (the key is never sent back to the page), sets npm/Hugging Face mirrors, follows the local runtime install, and removes the local model; the page and `/kb semantic local` share one install, so starting it in both places runs it once.
- OCR can be set on the web page too (languages from a list, optional OCR server such as PaddleOCR), and OCR changes now apply to the next import without restarting pi.
- Settings stay in step across pi windows: each one notices when `config.json` changes (within about 2 seconds) and switches semantic search, OCR, on/off and language to match; saving a setting starts from the file, so it no longer overwrites a change made in another window.

### One web page for sessions, knowledge and learning

- `/reload` no longer takes the web page down: the shared pi-web server restarts at the same address once the reloaded plugins mount, so open pages (knowledge base, sessions, learn) reconnect. `/kb web stop` still stops it. `src/hub.ts` changed; pi-sessions and pi-learn carry the same copy.
- The web API returns a note's body without its front matter (`text`), with the fields in `note` and the whole file in `raw` for editing, so pi-learn no longer quizzes on note metadata such as creation dates.

### Note reminder and model checks

- The note reminder also recognises fixes made through other tools that write files, such as pi-robot's `code` runner, not only edit, write and bash. Read-only tools and knowledge base tools never count.
- `scripts/model-check --installed` runs with your installed extensions and skills. Two new scenarios check the overlap with pi-embedded-docs: saving a project PDF must use `kb_add`, and a question about a project PDF must not file it away. A fictional XR-200 datasheet (generated, no third-party content) is the fixture. With pi-robot installed, gpt-6-sol kept the two tool sets apart in every run.

## v0.2.2 — 2026-09-25

### Managing a growing knowledge base

- Files with the same name no longer share a title: when names clash, titles show as much of the folder path as tells them apart (`[project-3/README.md]`, `[project-17/README.md]`), on the earlier document too. Unique names are unchanged; web uploads, which have no folder, are numbered (`README.md (2)`). Retrieval checked against v0.2.1 on 54 documents including 15 same-named READMEs: identical ranks for all 24 questions.
- Importing a changed file from the same path (or uploading one with the same name) asks first: replace the old version, keep both, or cancel. A replacement keeps the old title and deletes the old original and index, so the knowledge base no longer quietly holds two revisions of a manual.
- Web uploads go through the same background queue as `/kb add`: the page shows progress (also for imports started in the terminal) and asks about new versions in a dialog.
- `/kb list [words]` filters by title and shows at most 50 items, pointing to `/kb web` for the rest.

## v0.2.1 — 2026-09-25

### Importing

- `/kb add` imports in the background: it returns at once, the status bar shows progress (`📥 2/5 manual.pdf 3:12`), and a summary appears when all files are done. Each file is searchable as soon as it is done.
- `/kb cancel` stops the import in progress; files already imported are kept.
- PDFs and images are parsed in a child process, so pi stays responsive and Tesseract's debug output no longer scribbles over the terminal. Converted text is byte-identical to before (checked on 7 files, 216 pages).
- `kb_add` waits up to 30 seconds, then leaves the import to finish in the background and tells the agent so.

### Notes and citations

- A hidden reminder asks the model once whether to save a note when a run fixed a bug (a failed command, then a changed file) or the user said something lasting ("以后…", "from now on…") and `kb_note` was not called. gpt-6-luna went from 0/3 to 3/3 notes after debugging; routine scenarios never triggered it.
- `kb_search`'s `scope` now says to leave it at `all`: gpt-6-luna searched with `docs` and missed wiki notes.
- Citations stay next to the facts they support, without section names inside the brackets; the model is told the knowledge base is its only memory across sessions, so it does not promise to remember what it has not saved.
- `scripts/model-check` counts the reminder and reads every agent run.
- New `trivial-fix` scenario (a typo fails a test): the reminder fires, but neither gpt-6-sol nor gpt-6-luna saved a note or added a message (6/6).

### Safety and housekeeping

- `kb_add` asks before importing anything outside the project folder (symlinks are followed), and refuses without a UI. The agent could otherwise be steered by a document or web page into filing away files like `~/.ssh` and sending them to an embeddings API.
- `/kb semantic remove` deletes the local model runtime and files (about 1.1 GB) after confirming, turning semantic search off first if it uses them. Documents, notes and stored vectors stay.
- Appending to a note keeps the new content's own heading and puts the date below it, instead of stacking a date heading on top of it.
- When appending, the model is told to write only what is new under a heading naming it; gpt-6-luna had been copying the whole note into each appended section.
- After the user declines a kb_add or kb_note, the model no longer refuses when the user asks again (it had read "Do not retry" as final); it calls the tool again and the user is asked again.

### Docs

- Supported material is PDF, images and Markdown / text; Word, PowerPoint and Excel are marked experimental (need LibreOffice, untested).
- `scripts/model-check` defaults to `openai-codex/gpt-6-luna`.

## v0.2.0 — 2026-09-24

First tagged release. 0.1.0 was never tagged; everything up to now is listed here.

### Knowledge base

- Import PDFs, Word / PowerPoint / Excel (via LibreOffice), images and scans (Tesseract OCR, `eng+chi_sim`), Markdown and text with `/kb add` or the `kb_add` tool; page numbers are kept for citations.
- Agent tools `kb_search` and `kb_read`, with citations like `[manual.pdf p.12]`; nothing is injected automatically, the agent searches when it needs to.
- `/kb on` / `/kb off` (saved) and `pi --kb on|off` (this run only); when off, the tools and prompt section are removed.

### Experience notes (wiki)

- `kb_note` saves lessons, root causes, workarounds and preferences as Markdown wiki notes; every note is previewed with Save / Edit, then save / Don't save. Notes with the same title are appended to or replaced instead of duplicated.
- `/kb note [focus]` asks the agent to review the conversation and save what is worth keeping.
- Hand-written notes in `wiki/` are indexed; `/kb sync` re-indexes after manual edits.

### Search

- Keyword search: SQLite FTS5 trigram, Chinese and English; more than half of the terms must match, English matches at word starts and plurals match singulars, stop words and question words are ignored.
- Optional semantic search (`/kb semantic api|local|off`): any OpenAI-compatible embeddings API (default OpenAI `text-embedding-3-small`), or local Qwen3-Embedding-0.6B installed on demand. Merged with keyword results by RRF; semantic-only hits are marked and filtered by a per-model similarity floor.
- `/kb eval` measures retrieval on your own questions (hit@1/3/8, MRR, empty when there is no answer) and compares keyword, hybrid and semantic modes.

### Interface

- Chinese and English interface (`/kb lang zh|en|auto`, `PI_KB_LANG`); model-facing text stays English.
- `/kb web`: local web page on the shared pi-web hub (with [pi-sessions](https://github.com/woertedetiankong/pi-newsession)) to import by drag and drop, search, read pages, and edit notes.

### Model behavior

- Checked with gpt-5.5 using the new `scripts/model-check` (12 scenarios, fictional corpus, `pi -p --mode json`). Two system prompt changes came out of it:
  - `kb_note` is now called "before your final reply, once the fix is verified" instead of "at a natural stopping point": notes after debugging went from 2/3 to 8/8 runs, with no notes for routine work.
  - When the documents do not answer directly, the agent says so first and keeps its own inference uncited: from 0/3 to 5/8 runs on a question the documents do not cover.

### Project

- MIT license, English README (`README.en.md`), this changelog.
- `scripts/model-check`: repeatable real-model check of tool use and citations (see README → Development).
