import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chunkPages } from "../src/chunk.ts";
import { normalizeText } from "../src/convert.ts";
import { matchDocs, ocrHint, padDisplay, opener, pageList, splitArgs } from "../src/index.ts";
import { pathsOutside } from "../src/kb.ts";
import { containsTerm, coverage, planQuery } from "../src/search.ts";

test("splitArgs handles quotes and drag-and-drop escapes", () => {
	assert.deepEqual(splitArgs('add "My Docs/a b.pdf" ~/x\\ y.md --note'), ["add", "My Docs/a b.pdf", "~/x y.md", "--note"]);
	assert.deepEqual(splitArgs("  "), []);
	assert.deepEqual(splitArgs('search ""'), ["search", ""]);
	// Windows paths keep their backslashes; quotes still group paths with spaces.
	assert.deepEqual(splitArgs('add C:\\Users\\me\\manual.pdf "D:\\My Docs\\a b.pdf"', "win32"), ["add", "C:\\Users\\me\\manual.pdf", "D:\\My Docs\\a b.pdf"]);
	assert.deepEqual(splitArgs("add ~/x\\ y.md", "linux"), ["add", "~/x y.md"], "macOS/Linux drag-and-drop escapes");
});

test("normalizeText removes OCR gaps between Chinese characters and Markdown escapes", () => {
	assert.equal(normalizeText("推 荐 工作 电压 3.3V"), "推荐工作电压 3.3V");
	assert.equal(normalizeText("CTRL\\_REG 地 址 0x40"), "CTRL_REG 地址 0x40");
});

test("planQuery routes short terms to LIKE and expands long Chinese runs into trigrams", () => {
	const plan = planQuery("VDD 电压 供电电压范围");
	assert.deepEqual(plan.short, ["电压"]);
	assert.match(plan.match ?? "", /"vdd"/);
	assert.match(plan.match ?? "", /"供电电"/);
	assert.equal(coverage(plan, { title: "", heading: "", content: "VDD 供电电压范围 2.7V", bm25: 0 }), 1);
});

test("chunkPages keeps page numbers and carries headings across pages", () => {
	const chunks = chunkPages([
		{ page: 1, markdown: "# Intro\n\nhello" },
		{ page: 2, markdown: "continued text" },
	]);
	assert.deepEqual(
		chunks.map((c) => [c.page, c.heading, c.content]),
		[
			[1, "Intro", "# Intro\n\nhello"],
			[2, "Intro", "continued text"],
		],
	);
	const long = chunkPages([{ page: 1, markdown: "x".repeat(3000) }], 1200);
	assert.equal(long.length, 3);
});

test("padDisplay aligns Chinese and ASCII labels to the same column", () => {
	assert.equal(padDisplay("PDF", 7), "PDF    ");
	assert.equal(padDisplay("文本", 7), "文本   ");
	assert.equal(padDisplay("toolongname", 4), "toolongname ");
});

test("planQuery drops stop words and Chinese question words, unless nothing else is left", () => {
	assert.deepEqual(planQuery("how to bake bread").terms, ["bake", "bread"]);
	assert.deepEqual(planQuery("怎么切换模型").terms, ["切换模型"]);
	assert.deepEqual(planQuery("芯片最高能承受多少伏吗").terms, ["芯片最高能承受多少伏"]);
	assert.deepEqual(planQuery("the").terms, ["the"]);
});

test("containsTerm matches English at word starts, short words whole, Chinese anywhere", () => {
	assert.ok(containsTerm("use the pi cli", "pi"));
	assert.ok(!containsTerm("call the api", "pi"), "short words must be whole words");
	assert.ok(containsTerm("auto compaction runs", "compact"), "longer words match at a word start");
	assert.ok(!containsTerm("impact", "pact"));
	assert.ok(containsTerm("set ctrl_reg first", "ctrl_reg"));
	assert.ok(containsTerm("芯片的供电电压", "供电"));
	assert.ok(containsTerm("keyboard shortcut list", "shortcuts"), "plural matches singular");
	assert.ok(containsTerm("pattern match rules", "matches"));
	assert.ok(!containsTerm("a bus error", "buses"), "stems need four letters");
});

test("planQuery drops single Chinese characters left over from question words", () => {
	assert.deepEqual(planQuery("怎么用 tmux").terms, ["tmux"]);
	assert.deepEqual(planQuery("用").terms, ["用"], "kept when it is all there is");
});

test("pathsOutside flags paths that leave the project, through symlinks too", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-paths-"));
	try {
		const project = join(root, "project");
		mkdirSync(join(project, "docs"), { recursive: true });
		writeFileSync(join(root, "secret.txt"), "x");
		writeFileSync(join(project, "docs", "a.md"), "x");
		symlinkSync(join(root, "secret.txt"), join(project, "link.txt"));
		const inputs = ["docs/a.md", "./docs", join(project, "docs", "a.md"), "missing.pdf", "../secret.txt", join(root, "secret.txt"), "link.txt", "~/x.pdf", "..docs.md"];
		assert.deepEqual(pathsOutside(inputs, project), ["../secret.txt", join(root, "secret.txt"), "link.txt", "~/x.pdf"]);
		assert.deepEqual(pathsOutside(["~/notes"], homedir()), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("opener uses each system's default app; on Windows start gets an empty title argument", () => {
	assert.deepEqual(opener("darwin"), ["open"]);
	assert.deepEqual(opener("win32"), ["cmd", "/c", "start", ""]);
	assert.deepEqual(opener("linux"), ["xdg-open"]);
});

test("pageList joins runs of pages into ranges", () => {
	assert.equal(pageList([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
	assert.equal(pageList([4]), "4");
});

test("ocrHint flags scanned pages and pictures with text, not stray characters", () => {
	const scan = { page: 1, chars: 900, total: 950 };
	const figure = { page: 3, chars: 99, total: 1144 };
	const logo = { page: 4, chars: 3, total: 547 };
	assert.equal(ocrHint([logo], "pdf", true), "");
	assert.equal(ocrHint([], "pdf", true), "");

	const both = ocrHint([scan, figure, logo], "pdf", true);
	assert.match(both, /page 1 was read from an image by OCR/);
	assert.match(both, /Page 3 has some text read by OCR from pictures/);
	assert.doesNotMatch(both, /\b4\b/);
	assert.match(both, /viewing these pages \(kb_read with view: true\)/);

	assert.match(ocrHint([figure], "pdf", true), /viewing this page/);
	const noImages = ocrHint([scan], "pdf", false);
	assert.match(noImages, /with care/);
	assert.doesNotMatch(noImages, /view/);
	// Images imported before OCR shares were recorded are all OCR.
	assert.match(ocrHint([], "image", true), /This text was read from an image by OCR[\s\S]*viewing the image/);
});

test("matchDocs finds what /kb remove and /kb move name: id, exact title, or words from the title", () => {
	const docs = [
		{ id: "d-1a2b", title: "XR-100 手册.pdf" },
		{ id: "d-3c4d", title: "XR-200 手册.pdf" },
		{ id: "w-5e6f", title: "SPI 分频" },
		{ id: "w-7a8b", title: "SPI 分频踩坑" },
	];
	const ids = (q: string) => matchDocs(docs, q).map((d) => d.id);
	assert.deepEqual(ids("d-3c4d"), ["d-3c4d"], "an id");
	assert.deepEqual(ids("D-3C4D"), ["d-3c4d"], "ids ignore case");
	assert.deepEqual(ids("spi 分频"), ["w-5e6f"], "an exact title wins over titles that contain it");
	assert.deepEqual(ids("xr-100"), ["d-1a2b"]);
	assert.deepEqual(ids("手册"), ["d-1a2b", "d-3c4d"], "several matches: the user picks");
	assert.deepEqual(ids("  "), docs.map((d) => d.id), "nothing named: everything");
	assert.deepEqual(ids("docker"), []);
});
