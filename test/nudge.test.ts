import assert from "node:assert/strict";
import { test } from "node:test";
import { NUDGE_TYPE, noteNudge, nudgeText, shellWrites } from "../src/nudge.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });
const result = (toolName: string, isError = false) => ({ role: "toolResult", toolName, isError, content: [] });
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("a failure followed by a successful edit is a fixed bug", () => {
	const run = [user("运行 node app.js 报错了"), call("bash"), result("bash", true), call("read"), result("read"), call("write"), result("write"), call("bash"), result("bash"), reply("已修好")];
	assert.equal(noteNudge(run), "debugged");
});

test("a fix made with a shell command counts, a read-only command does not", () => {
	const bash = (id: string, command: string) => ({ role: "assistant", content: [{ type: "toolCall", name: "bash", id, arguments: { command } }] });
	const res = (id: string, isError = false) => ({ role: "toolResult", toolName: "bash", toolCallId: id, isError, content: [] });
	const fix = "python3 -c 'from pathlib import Path; p=Path(\"config.json\"); p.write_bytes(p.read_bytes()[3:])' && node app.js";
	assert.equal(noteNudge([user("修一下"), bash("1", "node app.js"), res("1", true), bash("2", fix), res("2"), reply("好了")]), "debugged");
	assert.equal(noteNudge([user("修一下"), bash("1", "node app.js"), res("1", true), bash("2", "xxd config.json 2>&1 >/dev/null"), res("2"), reply("看了")]), undefined);
	for (const cmd of ["sed -i '' 's/a/b/' f.js", "echo x > f.txt", "cat a | tee b", "mv a b", "perl -pi -e 's/a/b/' f"]) assert.ok(shellWrites(cmd), cmd);
	for (const cmd of ["npm test 2>&1", "ls -la", "grep -n x f.js", "node app.js >/dev/null"]) assert.ok(!shellWrites(cmd), cmd);
});

test("routine edits, lookups and failures without a fix do not nudge", () => {
	assert.equal(noteNudge([user("rename x to total"), call("read"), result("read"), call("edit"), result("edit"), reply("done")]), undefined);
	assert.equal(noteNudge([user("How do I roll back Orbit?"), call("kb_search"), result("kb_search"), reply("…")]), undefined);
	assert.equal(noteNudge([user("run the tests"), call("bash"), result("bash", true), reply("they fail")]), undefined);
	// An edit before the failure is not a fix.
	assert.equal(noteNudge([user("x"), call("edit"), result("edit"), call("bash"), result("bash", true), reply("…")]), undefined);
});

test("lasting statements from the user nudge, in Chinese and English", () => {
	assert.equal(noteNudge([user("以后调试 Flash 默认按 W25Q64JV 来"), reply("好")]), "told");
	assert.equal(noteNudge([user("From now on use pnpm, not npm"), reply("ok")]), "told");
	assert.equal(noteNudge([user("XR-100 默认电压是多少"), reply("3.3V")]), undefined, "默认 alone is a question, not a rule");
});

test("only the latest user message counts", () => {
	const earlier = [user("以后都用中文回答"), reply("好"), user("CTRL_REG 的地址是多少"), call("kb_search"), result("kb_search"), reply("0x40")];
	assert.equal(noteNudge(earlier), undefined);
	const earlierFix = [user("fix it"), call("bash"), result("bash", true), call("edit"), result("edit"), reply("fixed"), user("thanks"), reply("np")];
	assert.equal(noteNudge(earlierFix), undefined);
});

test("never nudges twice or after kb_note", () => {
	const fixed = [user("修一下"), call("bash"), result("bash", true), call("edit"), result("edit"), reply("好了")];
	assert.equal(noteNudge([...fixed, call("kb_note"), result("kb_note")]), undefined);
	assert.equal(noteNudge([...fixed, { role: "custom", customType: NUDGE_TYPE, content: nudgeText("debugged") }, reply("")]), undefined);
	assert.equal(noteNudge([]), undefined);
});
