/**
 * The demo: one API call, then poll until the app is live.
 *
 *   npm run demo
 *   npm run demo -- "Create an online catalog to sell handcrafted furniture"
 */
import { bold, dim, exitWith, green, heading, red } from "./support.js";

const DEFAULT_PROMPT = "Create an online catalog to sell handcrafted furniture";
const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 45 * 60 * 1000;

const gateway = (
	process.env.FACTORY_GATEWAY_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
const key = process.env.FACTORY_API_KEY?.trim();
const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
const user = process.env.FACTORY_USER?.trim() || "demo";

if (!key) {
	console.error(red("FACTORY_API_KEY is not set."));
	process.exit(1);
}

heading("Request");
console.log(`  ${dim("POST")} ${gateway}/v1/apps`);
console.log(`  ${dim("prompt")} ${prompt}`);
console.log(`  ${dim("user")} ${user}`);

const created = await fetch(`${gateway}/v1/apps`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${key}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({ prompt, user }),
});

const accepted = (await created.json()) as { runId?: string; error?: string };
if (!created.ok || !accepted.runId) {
	console.error(red(`  ${created.status} ${accepted.error ?? "unknown error"}`));
	process.exit(1);
}
console.log(`  ${green("202")} run ${accepted.runId}`);

heading("Progress");
const deadline = Date.now() + TIMEOUT_MS;
let lastStage = "";

while (Date.now() < deadline) {
	await sleep(POLL_INTERVAL_MS);

	const response = await fetch(`${gateway}/v1/apps/${accepted.runId}`, {
		headers: { authorization: `Bearer ${key}` },
	});
	if (!response.ok) {
		console.error(red(`  polling failed with ${response.status}`));
		continue;
	}

	const run = (await response.json()) as {
		status: string;
		stage: string | null;
		progress: string | null;
		appName: string | null;
		urls: { web: string | null; api: string | null };
		blueprintPath: string | null;
		summary: string | null;
	};

	const stage = `${run.status}/${run.stage ?? "-"}`;
	if (stage !== lastStage) {
		lastStage = stage;
		console.log(`  ${dim(new Date().toLocaleTimeString())} ${stage}`);
		if (run.progress) console.log(`    ${dim(run.progress)}`);
	}
	if (run.status === "running") continue;

	heading("Result");
	console.log(`  ${bold(run.status)}`);
	if (run.appName) console.log(`  app        ${user}/${run.appName}`);
	if (run.blueprintPath) console.log(`  blueprint  ${run.blueprintPath}`);
	if (run.urls.web) console.log(`  storefront ${green(run.urls.web)}`);
	if (run.urls.api) console.log(`  api        ${run.urls.api}`);
	if (run.summary) console.log(`\n${run.summary}\n`);

	exitWith([
		run.status === "deployed"
			? { level: "ok", message: "Deployed." }
			: { level: "fail", message: `Run ended as ${run.status}.` },
	]);
}

console.error(red("Timed out waiting for the run to finish."));
process.exit(1);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
