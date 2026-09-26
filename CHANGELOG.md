# Changelog

## Unreleased

The terminal catches up with the web page, and Markdown can switch between note and document:

- `/kb reread <title or id>` reads a PDF, image or Office document again from its original with the current OCR settings, like "Read again" on the web page: in the background, keeping its id, title and import date. Several matches (or none named) open a picker of those documents only; without the original on this computer it says why.
- On the web page, a note's page has "Make it a document" and a Markdown document's page "Make it a note", so a README dropped on the page (which takes Markdown as notes) can be turned into reference material any time, not only from the 10-second toast; the toast's "Import as documents instead" uses the same conversion now. Hovering "Documents" and "Notes" in the sidebar explains the difference.
- `/kb add` keeps importing Markdown as documents (a folder of project docs should not turn into dozens of notes), but the import summary now says so and how to make one a note (`/kb remove`, then `/kb add <file> --note`). The agent's `kb_add` imports show the same hint.

## v0.5.14 — 2026-09-26

Web page:

- Dropping files needs no aim: Markdown files become notes and everything else documents (the two drop halves are gone), and the import button follows the same rule. When Markdown was taken as notes, the toast says so and offers "Import as documents instead", which removes those notes and imports the files as documents.
- "Read again" on a PDF, image or Office document converts it again from its original with the current OCR settings, so changing the OCR language or server no longer means deleting and re-importing. The document keeps its id, title and import date (earlier citations still fit); when the new conversion gives no text, the old text stays. It runs in the import queue (progress, `/kb cancel`, resumed after pi stops); without the original on this computer (a project knowledge base does not commit originals by default) the page says so.
- A search with fewer than 3 results offers "Ask AI" below them, which asks the same question with several wordings in both languages.

## v0.5.13 — 2026-09-26

- One word for each thing in the interface: imported files are 资料 / documents and lessons are 笔记 / notes, in the terminal and on the web page. 文档, wiki 笔记, 经验笔记, "wiki notes" and "experience notes" are gone ("wiki" is left only where it names the `wiki/` folder). Office files show as "Office" in Chinese too. Text for the model is unchanged.

## v0.5.12 — 2026-09-26

- Fewer commands to wade through: typing `/kb ` completes only the everyday ones (add, search, web, note, list, remove, cancel, status, on, off, help); the rest (init, move, semantic, lint, eval, open, lang, sync) appear once their first letters are typed. New `/kb help` lists everything in two groups, and `/kb status` and unknown subcommands point to it.

## v0.5.11 — 2026-09-26

- Imports survive quitting pi, `/reload`, `/new` and `/resume`: the files not imported yet are recorded in `~/.pi/kb/pending-imports/` and the next pi that starts imports them (the one being converted starts over). Web uploads are copied first, since their temporary files are deleted. Files for a project knowledge base wait until pi runs in that project; several windows stopping or starting at once neither lose nor double-import a batch, and a batch whose pi crashed is picked up again. `pi -p` runs don't take them over.

## v0.5.10 — 2026-09-26

- No more syncing by hand: the global knowledge base now notices changed files the way a project one does, so documents and notes from another computer (a shared iCloud or Dropbox folder) or notes edited by hand show up within seconds, at the next search or page load. The web page's "Sync with the folder" button is gone; `/kb sync` stays for forcing it.
- `/kb remove` and `/kb move` take a title or words from it instead of an id copied from `/kb list`; when several items match, or none is given, pi asks which one. `/kb move` without `project` or `global` moves the item to the other one.

## v0.5.9 — 2026-09-26

From a simulated first session (a new user importing six English M5Stack PDFs and asking in Chinese):

- Faster imports of English documents: the Chinese OCR model made Tesseract about 4x slower (a 162-page datasheet: 455 s instead of 112 s) for 6% more OCR text. A PDF whose own text has no Chinese, Japanese or Korean is now OCR'd without those languages; scans and images keep every configured language, and an OCR server keeps its own.
- The status bar showed "first OCR: downloading language data" for the whole first file (5 minutes on a large PDF). It now shows while the data is actually downloading, and only for the languages the file needs.
- The semantic search tip no longer says a Chinese question won't find English documents: pi's answers found them every time by searching in both languages. It now says that your own searches (`/kb search`, the web page) are the ones that need the exact words.

## v0.5.8 — 2026-09-26

- First run: while the knowledge base is empty, pi says once how to add documents (`/kb add`, `/kb web`) and that you then just ask; `/kb status` repeats the hint while it stays empty.
- Semantic search: after the first import, a one-time tip explains that with keyword search only, a Chinese question won't find English documents (and the other way round), and how to turn semantic search on (local or online, with what each costs). `/kb search` shows it when nothing is found, and the agent's `kb_search` tells the model, so it can mention `/kb semantic` if a question likely missed for that reason. Shown tips are remembered in `config.json` (`tips`).

## v0.5.7 — 2026-09-26

Four races found with TLA+ models (`specs/tla`) and reproduced on the real code (`test/concurrency.test.ts`):

- Uploading a changed file on the web page while an earlier upload of the same name was still waiting in the import queue did not ask first; both were kept, the second as "name (2)". Queued uploads now count as earlier versions.
- Choosing "Replace" for two new versions in a row kept both: each was set to replace the version imported when it was queued, which the first had already replaced. Which versions to replace is now decided when the import runs (`replace` is a yes/no choice, not a list of ids).
- Switching the embedding model while a batch was being embedded left the new model with no vectors until the next import or restart, while the status said idle. The loop now starts over for the current model.
- Editing a note while its old text was being embedded kept the vector of the old text for good: the new chunk got the same rowid back, so the old vector passed the "chunk still there" check. Vectors are now stored only when the chunk's text is unchanged.

## v0.5.6 — 2026-09-26

- `kb_read` says when text came from OCR: at the top of its output it names the pages whose text was mostly read from an image (scans, photos) and those with some text read from pictures on the page (figures, diagrams), and suggests viewing them before relying on exact values (or treating them with care, for models without images). Stray OCR characters such as logos are ignored. The share is recorded on import as a `<!-- kb:ocr n/total -->` line after each page marker, a separate line so older versions still read the pages; it is hidden from search, the web page and read results. Images imported earlier are treated as OCR; PDFs imported earlier have no record, so they get no hint until removed (`/kb remove <id>`) and added again.
- With gpt-6-sol on a scanned PDF (an OCR error in the title, a flattened table), a register lookup read the text, saw the hint and viewed the page before answering.

## v0.5.5 — 2026-09-26

- `scripts/model-check` has a `figure-only` scenario: the answer (a board's outline and mounting-hole spacing) is only in a drawing, `corpus/xr100-outline.pdf`, generated by `xr100-outline.ts` with its dimensions drawn as lines, so the page has to be viewed. Scenarios can require or forbid `kb_read` with `view` (`view: "required"`), and the report shows `:view` and the pages read. gpt-6-sol: 3/3, and the other XR-100 scenarios still pass with the drawing in the knowledge base.

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
