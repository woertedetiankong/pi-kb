import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Converter } from "../src/convert.ts";

const fixtures = join(import.meta.dirname, "fixtures");
/** Language data downloaded once and shared by the tests (see kb.test.ts). */
const cache = process.env.PI_KB_TESSDATA ?? join(tmpdir(), "pi-kb-test-tessdata");

test("OCR languages per document: Chinese models only where the document's own text has Chinese", async () => {
	const c = new Converter({ ocrLanguage: "eng+chi_sim", tessdataDir: cache });
	try {
		const outline = join(import.meta.dirname, "..", "scripts", "model-check", "corpus", "xr100-outline.pdf");
		assert.equal(await c.ocrLanguageFor(outline, "pdf"), "eng", "English text only");
		assert.equal(await c.ocrLanguageFor(join(fixtures, "xr100-manual.pdf"), "pdf"), "eng+chi_sim", "Chinese text");
		assert.equal(await c.ocrLanguageFor(join(fixtures, "scan-note.png"), "image"), "eng+chi_sim", "an image has no text to judge by");

		c.setOcr({ ocrLanguage: "chi_sim" });
		assert.equal(await c.ocrLanguageFor(outline, "pdf"), "chi_sim", "never left with no language");
		c.setOcr({ ocrLanguage: "eng+chi_sim", ocrServerUrl: "http://localhost:8828/ocr" });
		assert.equal(await c.ocrLanguageFor(outline, "pdf"), "eng+chi_sim", "an OCR server keeps its settings");
	} finally {
		c.close();
	}
});

test(
	"the download note ends when the language data is there, not when the file is done",
	{ skip: !existsSync(join(cache, "eng.traineddata")) && "needs eng.traineddata in the test cache (kb.test.ts downloads it)" },
	async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kb-ocr-note-"));
	const saved = { proxy: process.env.HTTPS_PROXY, proxyLower: process.env.https_proxy };
	// No downloads: the language data arrives by copy, as if the download had just finished.
	process.env.HTTPS_PROXY = process.env.https_proxy = "http://127.0.0.1:9";
	const tessdata = join(root, "tessdata");
	mkdirSync(tessdata);
	const c = new Converter({ ocrLanguage: "eng", tessdataDir: tessdata });
	try {
		const seen: boolean[] = [];
		await c.convert(join(fixtures, "scan-note.png"), undefined, (downloading) => {
			seen.push(downloading);
			if (downloading) copyFileSync(join(cache, "eng.traineddata"), join(tessdata, "eng.traineddata"));
		});
		assert.deepEqual(seen, [true, false]);

		seen.length = 0;
		await c.convert(join(fixtures, "scan-note.png"), undefined, (downloading) => seen.push(downloading));
		assert.deepEqual(seen, [], "nothing to download the second time");
	} finally {
		c.close();
		for (const [name, value] of [["HTTPS_PROXY", saved.proxy], ["https_proxy", saved.proxyLower]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
	},
);
