/** Render Sandboxes: the only machine any agent can reach. */
import { Render } from "@renderinc/sdk";
import type { Readable } from "node:stream";

const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_COLLECT_CHARS = 1_000_000;

/**
 * Quote a string for safe use as a single POSIX shell argument. Every command
 * the factory builds ends up here, so it lives beside the only thing that
 * executes one.
 */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

type SandboxesClient = InstanceType<
	typeof Render
>["experimental"]["sandboxes"];

export type UploadData = Buffer | Uint8Array | string | Readable;

export type ExecEvent =
	| { type: "output"; stream: "stdout" | "stderr"; data: string }
	| { type: "exit"; exitCode: number };

export interface ExecResult {
	output: string;
	exitCode: number;
}

export interface CreateSandboxOptions {
	timeoutSeconds?: number;
}

let cached: { client: SandboxesClient; ownerId?: `tea-${string}` } | undefined;

function api(): { client: SandboxesClient; ownerId?: `tea-${string}` } {
	if (!cached) {
		const ownerId = process.env.RENDER_WORKSPACE_ID as
			| `tea-${string}`
			| undefined;
		const render = new Render({
			ownerId,
			useLocalDev: false,
			baseUrl: "https://api.render.com",
		});
		cached = { client: render.experimental.sandboxes, ownerId };
	}
	return cached;
}

export class Sandbox {
	constructor(readonly id: string) {}

	async exec(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<AsyncGenerator<ExecEvent>> {
		const { client, ownerId } = api();
		return mapExecEvents(
			await client.exec(this.id, command, ownerId, opts?.signal),
		);
	}

	async run(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<ExecResult> {
		return collectExecOutput(await this.exec(command, opts));
	}

	async mustRun(command: string, label: string): Promise<string> {
		const { output, exitCode } = await this.run(command);
		if (exitCode !== 0) {
			throw new Error(
				`${label} failed (exit ${exitCode}): ${output.slice(0, 500)}`,
			);
		}
		return output;
	}

	async readFile(path: string): Promise<string> {
		return this.mustRun(`cat ${shellEscape(path)}`, `Read ${path}`);
	}

	async writeFile(path: string, content: UploadData): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash > 0) {
			await this.mustRun(
				`mkdir -p ${shellEscape(path.slice(0, slash))}`,
				`Create parent of ${path}`,
			);
		}
		await this.upload(path, content);
	}

	async listDir(path: string): Promise<string[]> {
		const output = await this.mustRun(
			`ls -1F ${shellEscape(path)}`,
			`List ${path}`,
		);
		return output.split("\n").filter(Boolean);
	}

	async upload(path: string, data: UploadData): Promise<void> {
		const { client, ownerId } = api();
		await client.upload(this.id, path, data, ownerId);
	}

	async terminate(): Promise<void> {
		const { client, ownerId } = api();
		await client.terminate(this.id, ownerId);
	}
}

export async function createSandbox(
	opts?: CreateSandboxOptions,
): Promise<Sandbox> {
	const { client, ownerId } = api();
	const created = await client.create({
		ownerId,
		timeoutSeconds: opts?.timeoutSeconds,
	});

	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await client.get(created.id, ownerId);
		if (current?.status === "running") return new Sandbox(created.id);
		if (current?.status === "errored" || current?.status === "terminated") {
			throw new Error(
				`Sandbox ${created.id} entered terminal state: ${current.status}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	throw new Error(
		`Sandbox ${created.id} was not ready within ${READY_TIMEOUT_MS}ms`,
	);
}

/** Agent tasks receive a sandbox id from workflow code, never a model. */
export function connectSandbox(sandboxId: string): Sandbox {
	return new Sandbox(sandboxId);
}

/** Drain an exec stream into one string. Capped at 1 MB. */
async function collectExecOutput(
	events: AsyncGenerator<ExecEvent>,
): Promise<ExecResult> {
	const chunks: string[] = [];
	let total = 0;
	let exitCode = -1;

	for await (const event of events) {
		if (event.type === "exit") {
			exitCode = event.exitCode;
		} else if (total < MAX_COLLECT_CHARS) {
			const chunk = event.data.slice(0, MAX_COLLECT_CHARS - total);
			chunks.push(chunk);
			total += chunk.length;
		}
	}

	return { output: chunks.join(""), exitCode };
}

async function* mapExecEvents(
	source: AsyncGenerator<{
		type: string;
		stream?: string;
		data?: string;
		exit_code?: number;
	}>,
): AsyncGenerator<ExecEvent> {
	for await (const event of source) {
		if (event.type === "output") {
			yield {
				type: "output",
				stream: (event.stream as "stdout" | "stderr") ?? "stdout",
				data: event.data ?? "",
			};
		} else if (event.type === "exit") {
			yield { type: "exit", exitCode: event.exit_code ?? 1 };
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
