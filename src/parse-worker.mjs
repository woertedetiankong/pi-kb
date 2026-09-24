// Runs one LiteParse conversion in its own process (see runParse in convert.ts).
// Plain JavaScript so it also runs from node_modules, where Node does not strip types.
process.once("message", async ({ path, config }) => {
	try {
		const { LiteParse } = await import("@llamaindex/liteparse");
		const result = await new LiteParse(config).parse(path);
		const pages = result.pages.map((p) => ({ pageNum: p.pageNum, markdown: p.markdown }));
		process.send({ ok: true, pages }, () => process.exit(0));
	} catch (error) {
		process.send({ ok: false, error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
	}
});
