# Changelog

## v0.8.0 — 2026-09-29

The local semantic model is now IBM Granite Embedding 97M: more accurate, ten times faster, a quarter of the memory.

- Default local model `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` (Apache 2.0, 121 MB, pinned) instead of Qwen3-Embedding-0.6B (597 MB). Seven local models were run on the scale test (682 documents and notes, 15,691 chunks, 96 answerable questions): keyword plus semantic search found the right page first for 84 with Granite, 78 with gte-multilingual-base, 69 with Qwen3, 61 with F2LLM-v2-160M, and 55 with multilingual-e5-small, potion-multilingual-128M or keywords alone; Chinese questions 46 of 51 with Granite, 30 with Qwen3. Granite embeds 42 chunks a second in 0.8 GB (Qwen3 3.4–4.4 in 2.4–3.1 GB): the scale-test knowledge base indexed through pi-kb in 9 minutes at 809 MB, instead of about 2.5 hours.
- Similarity floor 0.84 for Granite (its scores sit high): on the scale test it kept 94 of 95 right pages and returned nothing for 3 of 8 unanswerable questions (Qwen3's 0.43: 1 of 8).
- Local models set their batch size (`localBatch`): Granite one chunk at a time (fastest), Qwen3 two as before.
- A config that still names Qwen3 moves to Granite once (`migrations` in `config.json`), its vectors are rebuilt in the background and the Qwen3 files (about 600 MB) are deleted, but never through a `models` folder that links elsewhere. Choosing Qwen3 again afterwards is kept.
- Download and memory figures in the settings, `/kb semantic local` and the READMEs updated (about 620 MB in all, 0.8 GB while indexing).
- AI search keeps searching by keywords: with the AI's searches, adding Granite found the right page first as often (84 vs 85) and in the top 8 slightly more often (95 vs 92).

## v0.7.1 — 2026-09-28

Questions about parts the knowledge base does not have are answered as such, and Find with AI knows what the knowledge base holds.

- Part numbers nothing mentions: a question naming a part (a word that starts with a letter and has a digit, four characters or more: NX-999, ESP32-P4, STM32F103) that no document or note mentions, in any spelling (ESP32C3 = ESP32-C3, any case), gets a note first. The agent's `kb_search` result tells the model the results are about other things and not to give their values for that part; `/kb search`, the terminal row ("nothing mentions NX-999"), the web search and AI search lists say it too, and AI answers are told. Before, "NX-999 maximum supply voltage" listed the NX-104 datasheet first. On the 104 scale-test questions: all 4 unknown parts flagged, none of the 96 answerable questions, 0.2 ms per question. Checked in Chrome: the answer said the knowledge base has nothing on NX-999 and that the other parts' values do not apply to it.
- Find with AI (and AI answers) tell the planner what the knowledge base holds: collections and titles, titles differing only in numbers as one line (`nx-#-datasheet ×300`), without file extensions and README names, at most about 1,500 tokens (4,578 characters for the 682 scale-test items; DeepSeek caches it, so a search sends about 250 new tokens). It also keeps each search in one language, since mixed ones ("themes 主题 自定义") match nothing. Everyday-wording questions found first: 16 → 20 of 24 (DeepSeek flash), 11 → 19 (v4-pro); all 96: 85 → 85 and 83 → 91. Flash put the right NX datasheet but another of its pages first a few more times (it now also searches by title).

## v0.7.0 — 2026-09-28

AI does the rewording instead of semantic search: the web page's search box finds with AI, like pi-sessions, and semantic search is no longer pushed.

- "✨ Find with AI" (the button next to the search box, or Shift+Enter) replaces "Ask AI": the model turns the question into a few keyword searches (Chinese and English, the documents' own wording) and the page lists what they found as "AI search", with the searches above the list and a way out. One model call. Typing goes back to the instant word search.
- "Have AI answer from these results" above the list writes the cited answer from those same searches (one more call, no second planning).
- Why keyword searches: measured on 104 questions over 682 documents and notes (the scale test), the right page came first for 55 of 96 with word search, 69 with semantic search, 83-85 with the model's keyword searches (DeepSeek flash / v4-pro), and 65-67 with the model's searches plus semantic search. AI search and AI answers now search by keywords, and use semantic search only when no keyword search finds anything. The real agent in pi (DeepSeek flash, 64 questions) cited the right document 54 times with semantic search off and 55 with it on.
- When word search finds fewer than 3 results, the hint below offers Find with AI instead of turning on semantic search.
- Semantic search is no longer pushed. It stays in Settings and `/kb semantic` for those who want it, but nothing suggests it any more: not the tip after the first import, not an empty `/kb search` (it now suggests other words, the other language, or asking pi), not the agent's no-match result (which told the model to recommend it), and not the web page (the one-click dialog, the hint under few results and the overview line while it is off are gone; Settings says when it is worth it). Why: the real agent in pi (DeepSeek flash, only the knowledge base tools, 64 questions) cited the right document 54 times with it off and 55 with it on, gave the right value for all 20 part-number questions and said "not in the knowledge base" for all 8 unanswerable ones either way, and took 9.8 s per question instead of 16.3 s. It searched about 2.8 times per question and switched language by itself. The local model holds about 1.6 GB and indexing takes 2–3 GB and half the CPU, which is what made a Windows user's computer lag.
- Checked in Chrome with DeepSeek flash on the scale-test knowledge base: "BMI270 加速度计量程最大是多少" found nothing by words; Find with AI searched "BMI270 accelerometer range · BMI270 量程 · …" and listed BMI270 pages first; the answer said ±16g, citing p.109 (ACC_RANGE) and p.2.

## v0.6.6 — 2026-09-28

The agent can list what is in the knowledge base.

- New `kb_list` tool: every document and note by title, with pages, date added and id, optionally only those whose title or file path contains a word. Over 100 items it pages and opens with counts per collection and source folder. It reads the index only: no search, no semantic model.
- Why: the system prompt lists only the 15 newest documents, so "what files are in my knowledge base?" made the model guess with searches. With 42 documents, gpt-6-sol made 1–9 tool calls and named 13–42 of the titles (4 runs), twice by reading the knowledge base's internal files with the shell. With a local semantic model, every one of those searches used the model, and the first one loaded it (about 1.6 GB). With `kb_list`: one call in all 8 runs (Chinese and English), and each answer gave all 42 titles or the right counts with an offer of the full list. "Do I have ESP32 documents?" is one `kb_list` with `match`.
- The catalog in the system prompt says how many documents it leaves out and points to `kb_list`.
- Model check: new `list-contents` scenario; 36/36 runs passed with gpt-6-sol, and `kb_list` was never used for content questions.

## v0.6.5 — 2026-09-27

Semantic indexing with the local model no longer fills the CPU together with OCR, and several pi windows no longer index the same chunks.

- The local model (about half of the cores) and OCR (about as many) take turns instead of running at once: indexing pauses between batches while any pi on the computer reads a file with OCR, and background OCR starts its next document only once no local-model indexing is going on. Imports never wait. The status bar shows `🧠 120/600 ⏸` and the web page "paused while text in pictures is read" while indexing waits. Measured on a 10-core M5 with the BMI270 datasheet plus 137 other chunks: seconds with the CPU at 90% or more went from 21 to 7–11 (OCR's own peaks, which LiteParse does not let us limit), all done in about 4¼ minutes instead of 3½.
- One pi window indexes each knowledge base (a claim file per knowledge base under `embed-claims/`, like the OCR claims); the others show its progress, load no model for it (2–3 GB each) and take over when it closes. Two windows on one knowledge base embedded 1.23× its chunks before, exactly 1× now.
- Checked live with two pi windows on one knowledge base (BMI270 datasheet in one, three Markdown files in the other): the second window's indexing waited (`⏸`, 0% CPU) while the first read pictures, then one window embedded all 581 chunks while the other showed its progress at 0% CPU and about 170 MB. This also found an OCR run that read a document a second time when another window had finished it meanwhile; OCR now checks again after taking its turn.
- Checked and left alone: capping the model's threads (2 threads: 2 cores, 35% slower) and background priority on macOS (2–5× slower, it runs on the efficiency cores).

## v0.6.4 — 2026-09-26

Semantic search is easy to find and to turn on: one button where it helps, one command in the terminal.

- Web page: "Turn on semantic search" under search results when keyword search found fewer than three hits, and in the overview while it is off. It opens a short dialog in plain words: what it does (Chinese finds English material, other wordings are found), that it runs locally and costs nothing, what is downloaded (about 1.1 GB once, or nothing when the model is there) and about how long indexing what you have takes (from the number of chunks, at the 3.5 chunks/s measured on a 24 GB Mac). "Turn on" starts the local model; progress shows where the hint was, and when indexing is done the current search runs again by meaning. The online API stays in Settings, one link away.
- Terminal: the tip after the first import and under an empty `/kb search` recommends one command, `/kb semantic local`, and says what it costs, instead of weighing local against online.
- Measured: `BMI270 供电电压范围` found nothing with keywords only; after turning semantic search on from that search (indexing 447 chunks took about 2.5 minutes), its first hit is p.12, the specification table with the supply voltage.
- Search snippets of documents imported before v0.6.2 no longer show LiteParse's picture links.
- Tests run on every push and pull request on Linux, macOS and Windows, with Node 22 and 24 (GitHub Actions). The first Windows run found two test problems, both in the tests: one deleted a folder with its index still open (Windows refuses), and one checked macOS drag-and-drop escapes without saying so. pi-kb itself passed all 142 other tests on Windows.

## v0.6.3 — 2026-09-26

You can see when the knowledge base helps: its tools show a one-line summary in pi's terminal instead of raw arguments and text.

- `kb_search`: `📚 KB search "BMI270 I2C address"` over `5 hits · bmi270-datasheet.pdf p.132, 145, 148-150 · note "SPI gotcha"` (pages sorted, runs as ranges, notes by title, `+N more` past three documents, files still importing), or `no matches`. Expanded (ctrl+o): each hit's citation and snippet, without Markdown marks.
- `kb_read`: the document's title (not its id) and pages; the result says how many characters came back, how many page pictures were viewed and whether there is more. Expanded: the start of the text.
- `kb_add`: `imported 2 · 1 already there`, `importing in the background 1/3` or `not imported`; `kb_note`: `✓ saved "…"` or `not saved`. Errors show their message in red.
- Follows the interface language (中文 / English). What the model reads is unchanged. Checked live with gpt-6-sol in both languages.

## v0.6.2 — 2026-09-26

- Pictures on PDF pages show as `[figure]` instead of LiteParse's `![](img_p12_1.png)`, a link to an image file that was never written. On the web page it is a "Figure · View page" button that opens the original at that page; the agent is told it marks a picture worth viewing with `kb_read view: true`. Documents converted before show the marker too when read, without converting again. The marker is kept out of the search index, so searching "figure", "p12" or "png" no longer finds every picture. Checked with 1488 heading queries over the four sticks3 datasheets and the ESP32-S3 manual (keyword search): the right page first 1392 times before and after, in the top 8 1480 → 1481.
- Web page: while OCR reads pictures in the background, the progress line shows how long the current document has taken (ticking every second) and how many more are waiting. Each waiting document carries a tag in the list ("reading pictures" on the current one, "pictures waiting" on the rest), and its page has a "Text in pictures" row; the page reloads the document when its OCR is done. The page checks the status every 2 s while importing or reading pictures, every 10 s otherwise.

## v0.6.1 — 2026-09-26

Imports are fast: PDFs are searchable by their text layer at once, and OCR adds the text inside their pictures in the background.

- Measured on the user's datasheets (Apple Silicon): time until searchable went from 73 s to 0.7 s for the 162-page BMI270 datasheet, and 7.6 s to 0.1 s for a 35-page one; the 1530-page ESP32-S3 manual is searchable in 2.8 s (its OCR was not timed; many minutes). OCR had cost about 100 times the time for about 1% more text (mostly figure labels, some noise).
- The background OCR runs the same full conversion as before, so the final text is unchanged. It runs when no import waits, one document at a time; a new import stops it and goes first. The status bar shows `🔍 reading pictures <file> 0:40`, `/kb status` counts the documents still waiting, and the web page shows a progress line. `/kb cancel` pauses it until the next import.
- The waiting state is kept in `docs/<id>.json` (`"ocr": "pending"`) and in the index, so OCR that pi did not finish resumes when pi starts again. A claim file in `ocr-claims/` keeps two pi windows from reading the same document. A copy of the folder elsewhere picks up the OCR'd text on sync; where the original is missing (project clones), the text layer counts as final there.
- Semantic indexing skips documents waiting for OCR, so their text is embedded once, after OCR, instead of twice.
- `kb_search` tells the model which documents are still waiting for OCR, so a figure label it cannot find yet is not reported as missing from the knowledge base.
- Scans (PDFs with almost no text layer), images and Office files are OCR'd during import as before. `/kb reread` still reads a document in full, pictures and all.

## v0.6.0 — 2026-09-26

Collections: group your global knowledge base by topic, and choose per project what it sees.

- A document or note can be in one or more collections ("ESP32", "STM32", …). A project sees what is in no collection plus the collections it uses; by default it uses all of them, so nothing changes until you choose. Choose with `/kb use <name…> | all | none` or in the web sidebar; the choice is kept in this computer's `config.json` by project root.
- Putting things in collections: `/kb add <folder>` offers one per subfolder and asks first (files directly in the folder get none); `/kb add <path> --to <name>`; `/kb group <title or id> <name>` (`-` for none), `--rename` and `--delete`; on the web page, a document's "Collections" row and a "Collection" picker for imports. Names ignore case.
- The agent's `kb_search` covers what the project sees and takes `shelf` for one collection ("look in the STM32 documents"); `kb_add` and `kb_note` take `shelf` too, and the note dialog shows the collection and can change it. The system prompt names the project's collections and the others; its catalog lists only what the project sees.
- Measured on 582 documents and 100 notes (300 look-alike generated datasheets in six families, six Espressif datasheets and the ESP32-S3 manual; 78 questions): with each question asked in a project that uses only its topic's collection, hybrid search got the right datasheet first for 46 of 60 part questions instead of 43, and quoted another part 4 times instead of 6 (semantic search alone: 3 instead of 14). Collections do not help within one topic: ESP32-C3 and ESP32-C6, both in "ESP32", still get mixed up 2 times in 12.
- Kept where the content is: `shelves` in `docs/<id>.json` and in a note's front matter, rebuilt into the index on sync, so they follow a synced folder to another computer. They follow new versions, rereads and note ⇄ document conversion; moving into a project's knowledge base drops them. Semantic search filters by collection too.

## v0.5.16 — 2026-09-26

- Settings → Storage location: typing a new folder and clicking Save did nothing (only the "Move here" button applied it) and the dialog closed as if it had. Save now applies a typed location too, with the same confirmation. The button is now "Use this location", and the copy checkbox says the originals are not deleted.
- Web page: with semantic search on and nothing imported yet, the overview says documents will be indexed automatically instead of "0 chunks", and while the first files import, the list says they will appear there instead of "The knowledge base is empty".

## v0.5.15 — 2026-09-26

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
