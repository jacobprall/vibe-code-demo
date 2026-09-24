/**
 * verify-app: build, boot, and query the app in the sandbox of the run, as
 * Render will. A check that fails is a result, not an error.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { appPath } from "../factory.config.js";
import {
	type Manifest,
	type Service,
	type VerifyAppInput,
	verifyAppInputSchema,
} from "./contracts.js";
import {
	appGitignore,
	readAppFiles,
	removeIgnored,
	runVerification,
} from "./git.js";
import { connectSandbox, type Sandbox, shellEscape } from "./sandbox.js";

/** verify-app builds each service and boots each web service. */
const VERIFY_TIMEOUT_SECONDS = 30 * 60;
const SMOKE_PORT = 8099;
const BOOT_ATTEMPTS = 15;
/** Proves a health endpoint answers before Postgres is reachable, as Render requires. */
const UNREACHABLE_DATABASE_URL = "postgres://unreachable/db";
/** `fromService` properties that give an address on Render's private network. */
const PRIVATE_NETWORK_PROPERTIES = new Set(["host", "port", "hostport"]);

/**
 * Verify the builder's files in the sandbox. A check that fails is a result,
 * not an error: the parent gives the failures to the builder, or it ends the
 * run.
 *
 * Render does not retry it. A retry after a timeout runs every build again.
 * And a service that the failed attempt started can still answer on the port
 * of the next boot, so a retry can pass a check that failed.
 */
export const verifyAppTask = task(
	{
		name: "verify-app",
		// The builds run in the sandbox, not on the compute of this task.
		plan: "starter",
		timeoutSeconds: VERIFY_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function verifyApp(
		_tasks: TaskContext,
		input: VerifyAppInput,
	): Promise<{ failures: string[] }> {
		const { sandboxId, user, appName, manifest, databaseUrl } =
			verifyAppInputSchema.parse(input);
		const failures = await verify(
			connectSandbox(sandboxId),
			appPath(user, appName),
			manifest,
			databaseUrl,
		);
		console.log(
			JSON.stringify(
				failures.length === 0
					? { event: "app_verified", user, appName }
					: {
							event: "app_verification_failed",
							user,
							appName,
							// The first line of each. The result has all of the text.
							failures: failures.map((failure) => failure.split("\n", 1)[0]),
						},
			),
		);
		return { failures };
	},
);

/**
 * Generic verification driven by the manifest. It starts from the files a
 * commit holds, because a fresh clone is all that Render's build gets. For
 * each service:
 * - For static sites: reject fromService properties on the private network
 * - Run the buildCommand in its rootDir
 * - For static sites: check staticPublishPath produced an index.html
 * - For web services with a healthCheckPath: boot it and curl the endpoint
 * - For web services with a dataCheckPath: migrate, boot against the sandbox's
 *   Postgres, and require the endpoint to answer with data
 * - Check for placeholder content in built output
 *
 * Last, it reads the files as publish-app does, so that the builder can fix
 * what publish-app would refuse: a symbolic link, for example.
 */
async function verify(
	sandbox: Sandbox,
	appDir: string,
	manifest: Manifest,
	databaseUrl: string | null,
): Promise<string[]> {
	const failures: string[] = [];

	// Only what is inside the app directory can be committed, so an empty one
	// is a build failure however good the model's summary sounds.
	const contents = await sandbox.run(`ls -A ${shellEscape(appDir)}`);
	if (contents.exitCode !== 0 || contents.output.trim() === "") {
		return [
			`Nothing was written to the app directory ${appDir}. ` +
				"Build the application there — relative paths already resolve to it — " +
				"and do not write anywhere else.",
		];
	}

	// Render's build gets only what the commit holds. Delete every ignored file
	// first, so that a file the build needs but a commit leaves out fails here
	// and not in a deploy.
	await sandbox.writeFile(`${appDir}/.gitignore`, appGitignore(manifest));
	await removeIgnored(sandbox, appDir);

	for (const service of manifest.services) {
		// This check needs no build, so a failed build cannot hide it.
		failures.push(...checkStaticSiteEnvVars(service));

		const serviceDir = resolveServiceDir(appDir, service.rootDir);

		// Run the build command.
		const build = await runVerification(sandbox, serviceDir, [
			service.buildCommand,
		]);
		if (!build.passed) {
			failures.push(
				`${service.name} (${service.rootDir}) build failed:\n${build.failures}`,
			);
			continue;
		}

		if (service.kind === "static_site" && service.staticPublishPath) {
			const publishDir = resolveServiceDir(
				serviceDir,
				service.staticPublishPath,
			);
			const index = await sandbox.run(
				`cat ${shellEscape(`${publishDir}/index.html`)}`,
			);
			if (index.exitCode !== 0) {
				failures.push(
					`${service.name}: ${service.staticPublishPath}/index.html was not produced by the build.`,
				);
			} else if (index.output.length < 200) {
				failures.push(
					`${service.name}: index.html is only ${index.output.length} bytes — the build produced an empty page.`,
				);
			} else {
				// Check for placeholder content in the built output.
				const placeholders = await checkForPlaceholders(sandbox, publishDir);
				failures.push(...placeholders);
			}
		}

		if (service.kind === "web_service") {
			failures.push(
				...(await checkWebService(sandbox, serviceDir, service, databaseUrl)),
			);
		}
	}

	const publishable = await readAppFiles(sandbox, appDir);
	if ("error" in publishable) failures.push(publishable.error);

	return failures;
}

/**
 * A static site gets its env vars at build time, and a browser uses them. The
 * sandbox build passes with a private-network address in the bundle. Without
 * this check, only smokeStorefront() finds the fault, after the Blueprint has
 * created every resource. The builder must make the fix, because the
 * storefront code must agree with the value. Web services can use these
 * properties, because they connect on the private network.
 */
export function checkStaticSiteEnvVars(service: Service): string[] {
	if (service.kind !== "static_site") return [];

	const failures: string[] = [];
	for (const { key, fromService } of service.envVars ?? []) {
		if (
			!fromService?.property ||
			!PRIVATE_NETWORK_PROPERTIES.has(fromService.property)
		) {
			continue;
		}
		const { name, property } = fromService;
		failures.push(
			`${service.name}: envVar ${key} uses fromService property ${property}. ` +
				"That is an address on Render's private network, and a static site is not on that network. " +
				"A browser cannot connect to a private-network name. " +
				`Replace property ${property} with envVarKey RENDER_EXTERNAL_HOSTNAME, the public hostname of ${name}.`,
		);
	}
	return failures;
}

/**
 * Two boots, because they prove different things. Against an unreachable
 * database, `healthCheckPath` must still answer — that is what Render's health
 * check does before the database is up, and a health endpoint that queries
 * will fail the deploy. Against the real one, `dataCheckPath` must return
 * data, which is the only check that the schema applied and the seed loaded.
 */
async function checkWebService(
	sandbox: Sandbox,
	serviceDir: string,
	service: Service,
	databaseUrl: string | null,
): Promise<string[]> {
	const failures: string[] = [];
	const startCommand = service.startCommand ?? "npm start";

	if (service.healthCheckPath) {
		const booted = await startService(sandbox, serviceDir, startCommand, {
			databaseUrl: UNREACHABLE_DATABASE_URL,
			readyPath: service.healthCheckPath,
		});
		await stopService(sandbox);
		if (booted) {
			failures.push(
				`${service.name}: GET ${service.healthCheckPath} did not answer within ${BOOT_ATTEMPTS}s with an unreachable database. ` +
					`Render calls it before Postgres is ready, so it must not query. ${booted}`,
			);
		}
	}

	if (!databaseUrl || !service.dataCheckPath) return failures;

	// Exactly what Render will run, in the same order, before the same start
	// command — so a migration that only works by accident fails here instead.
	if (service.preDeployCommand) {
		const migrated = await runVerification(sandbox, serviceDir, [
			`DATABASE_URL=${shellEscape(databaseUrl)} ${service.preDeployCommand}`,
		]);
		if (!migrated.passed) {
			failures.push(
				`${service.name}: preDeployCommand failed against a real Postgres:\n${migrated.failures}`,
			);
			return failures;
		}
	}

	const booted = await startService(sandbox, serviceDir, startCommand, {
		databaseUrl,
		readyPath: service.healthCheckPath ?? service.dataCheckPath,
	});
	if (booted) {
		await stopService(sandbox);
		failures.push(
			`${service.name}: did not boot against a real Postgres. ${booted}`,
		);
		return failures;
	}

	const probe = await probeService(sandbox, service.dataCheckPath);
	await stopService(sandbox);

	if (probe.status !== 200) {
		failures.push(
			`${service.name}: GET ${service.dataCheckPath} returned ${probe.status} against a real Postgres. ` +
				`Body:\n${probe.body.slice(0, 1_000)}`,
		);
	} else if (isEmptyPayload(probe.body)) {
		failures.push(
			`${service.name}: GET ${service.dataCheckPath} returned 200 but no data (${probe.body.slice(0, 200) || "empty body"}). ` +
				"The schema applied but nothing seeded it, so the deployed app will render an empty page. " +
				"Seed the tables from preDeployCommand.",
		);
	}

	return failures;
}

/** An endpoint that answers with nothing is the seed failing, not succeeding. */
function isEmptyPayload(body: string): boolean {
	const trimmed = body.trim();
	return (
		trimmed === "" ||
		trimmed === "[]" ||
		trimmed === "{}" ||
		/^\{\s*"\w+"\s*:\s*\[\s*\]\s*\}$/.test(trimmed)
	);
}

async function checkForPlaceholders(
	sandbox: Sandbox,
	dir: string,
): Promise<string[]> {
	const pattern =
		"lorem ipsum|coming soon|placeholder\\.com|via\\.placeholder|TODO:";
	const found = await sandbox.run(
		`grep -ril -E ${shellEscape(pattern)} ${shellEscape(dir)} || true`,
	);
	const files = found.output.trim();
	return files
		? [
				`Placeholder content reached the build output in ${files.split("\n").length} file(s). Replace it with real copy.`,
			]
		: [];
}

/**
 * Boot a service in the background and wait for it to answer. Returns null on
 * success, or the service log to report. The process outlives the exec that
 * started it, so callers can probe it over several requests before stopping
 * it; the sandbox is terminated in a `finally` regardless.
 */
async function startService(
	sandbox: Sandbox,
	serviceDir: string,
	startCommand: string,
	opts: { databaseUrl: string; readyPath: string },
): Promise<string | null> {
	const start =
		`cd ${shellEscape(serviceDir)} && rm -f /tmp/smoke.log && ` +
		`(nohup env PORT=${SMOKE_PORT} DATABASE_URL=${shellEscape(opts.databaseUrl)} ` +
		`${startCommand} >/tmp/smoke.log 2>&1 & echo $! >/tmp/smoke.pid) && ` +
		`for _ in $(seq 1 ${BOOT_ATTEMPTS}); do sleep 1; ` +
		`if curl -fsS -m 2 http://127.0.0.1:${SMOKE_PORT}${opts.readyPath} >/dev/null 2>&1; then ok=1; break; fi; done; ` +
		'if [ -z "$ok" ]; then echo "--- service log ---"; cat /tmp/smoke.log; exit 1; fi';

	const result = await sandbox.run(start);
	return result.exitCode === 0 ? null : result.output.slice(0, 2_000);
}

async function stopService(sandbox: Sandbox): Promise<void> {
	await sandbox
		.run('kill "$(cat /tmp/smoke.pid)" 2>/dev/null; rm -f /tmp/smoke.pid; true')
		.catch(() => {});
}

/** One request against the running service. */
async function probeService(
	sandbox: Sandbox,
	path: string,
): Promise<{ status: number; body: string }> {
	const result = await sandbox.run(
		`curl -sS -m 10 -o /tmp/probe.out -w '%{http_code}' ` +
			`http://127.0.0.1:${SMOKE_PORT}${path}; echo; head -c 4000 /tmp/probe.out`,
	);
	const [statusLine, ...rest] = result.output.split("\n");
	return {
		status: Number.parseInt(statusLine.trim(), 10) || 0,
		body: rest.join("\n"),
	};
}

/**
 * Join a manifest-declared subdirectory onto a base path. The manifest is
 * agent-authored, so tolerate the two things models get wrong: "." or "./"
 * meaning "this directory", and repeating the base path they were given.
 */
function resolveServiceDir(base: string, relative: string): string {
	const cleaned = relative.replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (!cleaned || cleaned === ".") return base;
	if (base.endsWith(`/${cleaned}`)) return base;
	return `${base}/${cleaned}`;
}
