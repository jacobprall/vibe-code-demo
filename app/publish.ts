/**
 * publish-app, and each other write to the apps repository. A write clones
 * the repository in a sandbox of its own, makes one change, commits only the
 * directory of one app and the root Blueprint, and pushes.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import {
	appPath,
	appRelativePath,
	factoryConfig,
} from "../factory.config.js";
import { appBlueprint, declaredResources, rootBlueprint } from "./blueprint.js";
import { appsRepo } from "./config.js";
import {
	type AppSpec,
	appSpecSchema,
	type PublishAppInput,
	publishAppInputSchema,
} from "./contracts.js";
import {
	cloneAppsRepo,
	commitPaths,
	githubToken,
	pushVerified,
	readAppFiles,
	writeAppFiles,
} from "./git.js";
import {
	connectSandbox,
	createSandbox,
	type Sandbox,
	shellEscape,
} from "./sandbox.js";

/** publish-app makes one commit and one push. */
const PUBLISH_TIMEOUT_SECONDS = 10 * 60;

/**
 * Copy the files of the app out of the sandbox of the run, into a new clone
 * of the apps repository in a sandbox of its own. There, write factory.json,
 * the app's render.yaml and README, and the root Blueprint from the spec,
 * commit them with the app, and push. Render deploys the push, so the parent
 * starts this only after verify-app passes. Returns the pushed commit, or
 * null when no file changed.
 *
 * The builder can run any command in the sandbox of the run. A process that
 * it starts stays after the command, and it can change git itself. So the
 * GitHub token never goes into that sandbox, and publish-app reads the files
 * of the app from it only as data.
 *
 * Render does not retry it. A retry after the push finds nothing to commit,
 * and the run then ends as if the push changed no files.
 */
export const publishAppTask = task(
	{
		name: "publish-app",
		plan: "starter",
		timeoutSeconds: PUBLISH_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function publishApp(
		_tasks: TaskContext,
		input: PublishAppInput,
	): Promise<{ commit: string | null }> {
		const { sandboxId, spec, message } = publishAppInputSchema.parse(input);
		const repoUrl = appsRepo().url;
		const appDir = appPath(spec.user, spec.appName);
		// verify-app read the same files. An error here means that they
		// changed after it.
		const built = await readAppFiles(connectSandbox(sandboxId), appDir);
		if ("error" in built) {
			throw new Error(`publish-app did not copy the app. ${built.error}`);
		}
		const commit = await inAppsClone(PUBLISH_TIMEOUT_SECONDS, (clone) =>
			commitAndPush(clone, spec, message, async () => {
				await writeAppFiles(clone.sandbox, appDir, built.files);
				await writeBlueprints(clone.sandbox, spec, appDir, repoUrl);
			}),
		);
		console.log(
			JSON.stringify({
				event: "app_published",
				user: spec.user,
				appName: spec.appName,
				commit,
			}),
		);
		return { commit };
	},
);

async function writeBlueprints(
	sandbox: Sandbox,
	spec: AppSpec,
	appDir: string,
	repoUrl: string,
): Promise<void> {
	// The .gitignore comes with the files of the app. verify() writes it,
	// because it must build from the same files that this commit holds.
	await sandbox.writeFile(
		`${appDir}/factory.json`,
		`${JSON.stringify(spec, null, 2)}\n`,
	);
	await sandbox.writeFile(`${appDir}/render.yaml`, appBlueprint(spec));
	await sandbox.writeFile(`${appDir}/README.md`, appReadme(spec, repoUrl));

	await writeRootBlueprint(sandbox);
}

/**
 * Regenerate the repository-root Blueprint from every app's factory.json.
 *
 * Derived state, never merged: a concurrent run adds its own app to the same
 * file. So when another run pushes first, the change that calls this runs
 * again on the new tip, and the file gets the apps of both runs.
 *
 * It reads the specs from a clone that no agent used. In it, the builder
 * wrote only the files of its own app, and publish-app wrote its
 * factory.json.
 */
export async function writeRootBlueprint(sandbox: Sandbox): Promise<void> {
	const specs = await readAllSpecs(sandbox);
	await sandbox.writeFile(
		`${factoryConfig.repoDir}/${factoryConfig.blueprintPath}`,
		rootBlueprint(specs),
	);
}

/**
 * The spec of each app in the clone. A spec counts only in the directory of
 * the app that it names, so a file in one app directory cannot declare the
 * resources of a different app.
 */
async function readAllSpecs(sandbox: Sandbox): Promise<AppSpec[]> {
	const root = `${factoryConfig.repoDir}/${factoryConfig.appsDir}`;
	const found = await sandbox.run(
		`find ${shellEscape(root)} -mindepth 3 -maxdepth 3 -name factory.json -print 2>/dev/null || true`,
	);

	const specs: AppSpec[] = [];
	for (const path of found.output.split("\n").map((line) => line.trim())) {
		if (!path.startsWith(`${root}/`)) continue;
		const raw = await sandbox.run(`cat ${shellEscape(path)}`);
		if (raw.exitCode !== 0) continue;
		try {
			const spec = appSpecSchema.parse(JSON.parse(raw.output));
			const [user, appName] = path.slice(root.length + 1).split("/");
			if (spec.user !== user || spec.appName !== appName) {
				console.warn(
					JSON.stringify({
						event: "skipped_app_spec",
						path,
						reason: `it names ${spec.user}/${spec.appName}`,
					}),
				);
				continue;
			}
			specs.push(spec);
		} catch {
			console.warn(JSON.stringify({ event: "skipped_app_spec", path }));
		}
	}
	return specs;
}

/** A sandbox that holds a clone of the apps repository, and how to push it. */
interface AppsClone {
	sandbox: Sandbox;
	token: string;
	remoteUrl: string;
}

/**
 * Clone the apps repository in a new sandbox, do the work, and terminate the
 * sandbox. No agent uses this sandbox, so the GitHub token can go into it.
 * The token comes just before the clone: an installation token expires after
 * an hour, and a run can take two hours.
 *
 * Each push makes its own clone, so it starts from the newest commit, and no
 * sandbox stays up while a run or the steps of a delete wait.
 */
export async function inAppsClone<T>(
	timeoutSeconds: number,
	work: (clone: AppsClone) => Promise<T>,
): Promise<T> {
	const repo = appsRepo();
	const sandbox = await createSandbox({ timeoutSeconds });
	try {
		const token = await githubToken();
		const remoteUrl = await cloneAppsRepo(
			sandbox,
			token,
			repo,
			factoryConfig.branch,
		);
		return await work({ sandbox, token, remoteUrl });
	} finally {
		await sandbox
			.terminate()
			.catch((error) => console.error("Failed to terminate sandbox:", error));
	}
}

/**
 * Make the change of one app in the clone, commit it, and push it. The
 * commit holds only the app's directory and the root Blueprint. When another
 * run pushes first, `change` runs again on the new tip. A change that
 * changes no file makes no commit, and there is nothing to push. Returns the
 * commit that it pushed, or null.
 */
export async function commitAndPush(
	clone: AppsClone,
	app: { user: string; appName: string },
	message: string,
	change: () => Promise<void>,
): Promise<string | null> {
	const paths = [
		appRelativePath(app.user, app.appName),
		factoryConfig.blueprintPath,
	];
	const commit = async () => {
		await change();
		return commitPaths(clone.sandbox, message, paths);
	};
	if (!(await commit())) return null;
	return pushVerified(
		clone.sandbox,
		clone.token,
		clone.remoteUrl,
		factoryConfig.branch,
		paths,
		commit,
	);
}

function appReadme(spec: AppSpec, repoUrl: string): string {
	const relative = appRelativePath(spec.user, spec.appName);
	return [
		`# ${spec.appName}`,
		"",
		spec.summary,
		"",
		`Generated by the Vibe Code factory from the prompt: "${oneLine(spec.prompt)}"`,
		"",
		"## Infrastructure",
		"",
		...declaredResources(spec).map((resource) => `- ${resource}`),
		"",
		"## Deploying this app on its own",
		"",
		"It is already deployed as part of the factory's Blueprint at the",
		"repository root. To run it as its own Blueprint instead, create a new",
		`Blueprint from ${repoUrl} with the Blueprint Path set to:`,
		"",
		"```text",
		`${relative}/render.yaml`,
		"```",
		"",
	].join("\n");
}

export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").slice(0, 120);
}

