import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Project knowledge bases live in <project>/.pi/kb, next to pi's own project settings, so they
 * travel with the repository: notes, converted text and document descriptions are committed;
 * originals (raw/) and the change log stay out of git (see GITIGNORE).
 */

export const PROJECT_DIR = join(".pi", "kb");

/** Kept out of git: originals are large (text is 2-7% of a PDF), log.md would conflict on every merge. */
export const GITIGNORE = "# pi-kb: originals stay on the computer that imported them; remove this line to share them too\nraw/\n# local change log (appended on every edit, would conflict in git)\nwiki/log.md\n";

const README = `# Project knowledge base (pi-kb)

Documents and experience notes for this project, shared through git.
Install [pi-kb](https://github.com/woertedetiankong/pi-kb) and pi searches them next to your own knowledge base.

- \`wiki/\`: experience notes (Markdown; edit freely)
- \`converted/\`, \`docs/\`: searchable text and descriptions of imported documents
- \`raw/\`: original files, not committed by default (see .gitignore)

项目知识库：本项目的资料和经验笔记，通过 git 共享。安装 pi-kb 后，pi 会同时检索这里和你自己的知识库。
`;

export interface ProjectKb {
	/** The project folder: where .pi/kb was found (or created). */
	root: string;
	/** <root>/.pi/kb, the content folder. */
	dir: string;
	/** Shown to the user, e.g. "xr100-firmware". */
	name: string;
}

/**
 * The nearest project knowledge base at or above `cwd`. `exclude` holds folders that are not
 * projects: the global knowledge base, which sits in ~/.pi/kb and would otherwise match from ~.
 */
export function findProjectKb(cwd: string, exclude: string[] = []): ProjectKb | undefined {
	const skip = new Set(exclude.map((d) => resolve(d)));
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const kb = join(dir, PROJECT_DIR);
		if (existsSync(kb) && !skip.has(resolve(kb))) return { root: dir, dir: kb, name: basename(dir) || dir };
		if (dirname(dir) === dir) return undefined;
	}
}

/** Where /kb init puts the project knowledge base: the git repository's top, else the current folder. */
export function projectRootFor(cwd: string): string {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return resolve(cwd);
	}
}

/** Create (or complete) a project knowledge base; returns it and whether it was new. */
export function initProjectKb(root: string): { project: ProjectKb; created: boolean } {
	const dir = join(root, PROJECT_DIR);
	const created = !existsSync(dir);
	for (const sub of ["wiki", "converted", "docs"]) mkdirSync(join(dir, sub), { recursive: true });
	const ignore = join(dir, ".gitignore");
	if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
	const readme = join(dir, "README.md");
	if (!existsSync(readme)) writeFileSync(readme, README);
	return { project: { root, dir, name: basename(root) || root }, created };
}
