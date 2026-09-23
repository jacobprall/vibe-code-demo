/**
 * The host must send every task in its one registration. The SDK starts its
 * task server soon after the first task() call, and a task that registers
 * later is never available: a dispatch of it fails with "task not found".
 * This comes from how Node loads the host's modules, so only a real Node
 * process shows it. The test runs app/host.ts in register mode against a
 * fake task server on a Unix socket.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Every task the host defines. scripts/doctor.ts checks the same names.
const TASKS = [
	"architect",
	"builder",
	"curator",
	"delete-app",
	"delete-app-resources",
	"deploy-manager",
	"prompt-to-app",
	"remove-app-files",
	"remove-app-from-blueprint",
	"wait-for-blueprint-syncs",
];

// Fake values that pass assertWorkflowEnv(). Register mode calls no service.
const FAKE_ENV = {
	APPS_REPO: "owner/generated-apps",
	ANTHROPIC_API_KEY: "fake",
	DATABASE_URL: "postgresql://fake@127.0.0.1:1/fake",
	GITHUB_TOKEN: "fake",
	RENDER_API_KEY: "fake",
	RENDER_WORKSPACE_ID: "tea-fake",
};

interface Registration {
	tasks: string[] | null;
	exitCode: number | null;
	output: string;
}

/** Run the host in register mode, as Render does, and record what it sends. */
async function register(): Promise<Registration> {
	const dir = mkdtempSync(join(tmpdir(), "host-test-"));
	const socketPath = join(dir, "sdk.sock");
	let tasks: string[] | null = null;

	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.url === "/register-tasks") {
				tasks = JSON.parse(body).tasks.map(
					(task: { name: string }) => task.name,
				);
			}
			response.setHeader("content-type", "application/json");
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	try {
		// Only these variables, so a developer's real credentials stay out.
		const child = spawn(process.execPath, ["--import", "tsx", "app/host.ts"], {
			cwd: ROOT,
			env: {
				...FAKE_ENV,
				RENDER_SDK_MODE: "register",
				RENDER_SDK_SOCKET_PATH: socketPath,
			},
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const exitCode = await new Promise<number | null>((resolve) =>
			child.on("close", resolve),
		);
		return { tasks, exitCode, output };
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("host", () => {
	it("registers every task before the task server starts", async () => {
		const { tasks, exitCode, output } = await register();

		expect(exitCode, output).toBe(0);
		expect(tasks?.sort(), output).toEqual(TASKS);
	}, 30_000);
});
