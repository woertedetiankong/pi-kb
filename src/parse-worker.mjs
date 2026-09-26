// Runs one LiteParse conversion, or renders some pages to PNG, in its own process (see runParse in convert.ts).
// Plain JavaScript so it also runs from node_modules, where Node does not strip types.
process.once("message", async ({ path, config, screenshot }) => {
	try {
		const { LiteParse } = await import("@llamaindex/liteparse");
		const parser = new LiteParse(config);
		if (screenshot) {
			const shots = await parser.screenshot(path, screenshot);
			const images = shots.map((s) => ({ pageNum: s.pageNum, png: s.imageBuffer.toString("base64") }));
			process.send({ ok: true, images }, () => process.exit(0));
			return;
		}
		const result = await parser.parse(path);
		const pages = result.pages.map((p) => ({ pageNum: p.pageNum, markdown: p.markdown }));
		process.send({ ok: true, pages }, () => process.exit(0));
	} catch (error) {
		process.send({ ok: false, error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
	}
});
