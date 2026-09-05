/**
 * The starting point a full-stack build begins from.
 *
 * Templates live in this repository rather than in a repository of their own,
 * which keeps them version-locked to the code that deploys them: a template
 * that assumes `preDeployCommand` cannot drift away from a `blueprint.ts` that
 * emits it, and `npm run check` builds them in CI, which is the only thing
 * that keeps a template working.
 *
 * They are materialized as one self-extracting shell script rather than a file
 * at a time. Every file goes through `sandbox.writeFile`, which costs two API
 * calls each; a forty-file template would be eighty round trips before the
 * builder has done anything.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Sandbox, shellEscape } from "./sandbox.js";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates", import.meta.url));

/**
 * Build output and dependencies are installed in the sandbox, not shipped.
 * `.dockerignore` already keeps most of this out of the image; skipping it here
 * too means a local checkout and a deployed one produce the same template.
 */
const SKIP = new Set(["node_modules", "dist", ".git", ".DS_Store"]);
const SKIP_SUFFIX = [".tsbuildinfo", ".log"];

/** Unlikely enough in source that the collision check below never fires. */
const HEREDOC = "AIRO_TEMPLATE_EOF";

export interface TemplateFile {
	/** Path relative to the template root, e.g. "web/src/App.tsx". */
	path: string;
	contents: string;
}

/** Read one template off disk. */
export async function readTemplate(name: string): Promise<TemplateFile[]> {
	const root = `${TEMPLATE_ROOT}/${name}`;
	const files: TemplateFile[] = [];

	async function walk(dir: string, prefix: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (SKIP.has(entry.name)) continue;
			if (SKIP_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) continue;
			const absolute = `${dir}/${entry.name}`;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(absolute, relative);
			} else if (entry.isFile()) {
				files.push({
					path: relative,
					contents: await readFile(absolute, "utf8"),
				});
			}
		}
	}

	await walk(root, "");
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One shell script that recreates every file. Quoted heredocs, so nothing in
 * a template is expanded by the shell on its way in.
 */
export function extractionScript(
	files: readonly TemplateFile[],
	destDir: string,
): string {
	const directories = new Set<string>();
	for (const file of files) {
		const slash = file.path.lastIndexOf("/");
		if (slash > 0) directories.add(file.path.slice(0, slash));
	}

	const lines = ["set -e", `cd ${shellEscape(destDir)}`];
	if (directories.size > 0) {
		lines.push(`mkdir -p ${[...directories].sort().map(shellEscape).join(" ")}`);
	}

	for (const file of files) {
		// A template line equal to the delimiter would end the heredoc early and
		// leave the rest of the file to run as shell.
		if (file.contents.split("\n").some((line) => line === HEREDOC)) {
			throw new Error(`${file.path} contains the heredoc delimiter`);
		}
		// A heredoc always terminates its last line, so a file that does not end
		// in a newline gains one. Every template file is source that should end
		// in one anyway; this makes the normalization deliberate rather than a
		// surprise in the diff.
		lines.push(
			`cat > ${shellEscape(file.path)} <<'${HEREDOC}'`,
			file.contents.replace(/\n$/, ""),
			HEREDOC,
		);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Write a template into the app directory. Returns the paths it created, which
 * is what the builder is told it starts from.
 */
export async function materializeTemplate(
	sandbox: Sandbox,
	name: string,
	destDir: string,
): Promise<string[]> {
	const files = await readTemplate(name);
	if (files.length === 0) throw new Error(`Template "${name}" is empty`);

	const scriptPath = `/tmp/airo-template-${Date.now()}.sh`;
	await sandbox.upload(scriptPath, extractionScript(files, destDir));
	try {
		await sandbox.mustRun(
			`sh ${shellEscape(scriptPath)}`,
			`Materialize the ${name} template`,
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(scriptPath)}`).catch(() => {});
	}

	return files.map((file) => file.path);
}
