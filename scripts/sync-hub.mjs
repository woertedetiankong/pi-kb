/**
 * Keep src/hub.ts the same in every package that ships it. pi-kb's copy is the source.
 *
 *   node scripts/sync-hub.mjs           copy it to the sibling repositories (../pi-sessions, ../pi-learn, ../pi-manage, ../pi-lab)
 *   node scripts/sync-hub.mjs --check   only compare; exits 1 when a sibling differs
 *
 * Both also list the copies pi has installed from GitHub (~/.pi/agent/git/...), which change only
 * after a push and `pi update`. Remember to bump HUB_VERSION in hub.ts with every change.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const repo = join(import.meta.dirname, "..");
const source = join(repo, "src", "hub.ts");
const SIBLINGS = ["pi-sessions", "pi-learn", "pi-manage", "pi-lab"];
const check = process.argv.includes("--check");

const text = (file) => readFileSync(file, "utf8");
const hash = (file) => createHash("sha256").update(text(file)).digest("hex").slice(0, 10);
const version = (file) => /HUB_VERSION = (\d+)/.exec(text(file))?.[1] ?? "?";
const want = hash(source);
console.log(`source  ${relative(process.cwd(), source) || source}  v${version(source)}  ${want}`);

let differ = 0;
for (const name of SIBLINGS) {
	const target = join(dirname(repo), name, "src", "hub.ts");
	if (!existsSync(target)) {
		console.log(`skip    ${name}: no ${relative(dirname(repo), target)}`);
		continue;
	}
	if (hash(target) === want) {
		console.log(`same    ${name}  v${version(target)}`);
		continue;
	}
	if (check) {
		differ++;
		console.log(`DIFFERS ${name}  v${version(target)}  ${hash(target)}`);
	} else {
		copyFileSync(source, target);
		console.log(`copied  ${name}  v${version(target)} (commit it there)`);
	}
}

// What pi runs: packages installed from GitHub; the newest HUB_VERSION among them wins.
const installed = join(homedir(), ".pi", "agent", "git", "github.com");
if (existsSync(installed)) {
	for (const owner of readdirSync(installed)) {
		for (const pkg of readdirSync(join(installed, owner))) {
			const file = join(installed, owner, pkg, "src", "hub.ts");
			if (existsSync(file)) console.log(`pi      ${owner}/${pkg}  v${version(file)}  ${hash(file) === want ? "same" : "older or different (push, then pi update)"}`);
		}
	}
}

if (differ) {
	console.log(`\n${differ} sibling copy(ies) differ: run node scripts/sync-hub.mjs to copy pi-kb's hub.ts over them.`);
	process.exit(1);
}
