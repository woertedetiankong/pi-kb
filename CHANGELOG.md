# Changelog

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
