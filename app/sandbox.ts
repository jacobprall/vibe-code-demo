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

	async exec(command: string): Promise<AsyncGenerator<ExecEvent>> {
		const { client, ownerId } = api();
		return mapExecEvents(await client.exec(this.id, command, ownerId));
	}

	async run(command: string): Promise<ExecResult> {
		return collectExecOutput(await this.exec(command));
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

	async download(path: string): Promise<Buffer> {
		const { client, ownerId } = api();
		return (await client.download(this.id, path, ownerId)).data;
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

/* ── Postgres in the sandbox ──────────────────────────────────────────── */

/**
 * Credentials for the throwaway database. It listens on loopback inside one
 * sandbox that is terminated at the end of the run, so these are fixed rather
 * than generated — a value the builder can read in its prompt and in
 * `DATABASE_URL` is one fewer thing for it to get wrong.
 */
export const SANDBOX_DATABASE_URL = "postgres://app:app@127.0.0.1:5432/appdb";

const START_POSTGRES = `
set -e

# psql ships in the image; the server does not.
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/tmp/pg-install.log 2>&1
fi

version="$(ls /etc/postgresql | sort -n | tail -1)"

# The image cannot resolve the name "localhost", and Postgres defaults to
# listen_addresses='localhost'. It resolves that name before binding, so it
# fails with "could not create any TCP/IP sockets" and never starts. Bind the
# address directly rather than depending on resolution.
#
# Keep the literal path to the hosts file out of this script: it is sent to
# Render as an HTTP body, and Cloudflare's managed rules read that string as a
# local-file-inclusion attempt and reject the exec with a 403 before it lands.
sed -i "s/^#*[[:space:]]*listen_addresses.*/listen_addresses = '127.0.0.1'/" \\
  "/etc/postgresql/$version/main/postgresql.conf"

pg_ctlcluster "$version" main start >/dev/null 2>&1 || true

for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432

# Idempotent: a rerun inside the same sandbox must not fail on "already exists".
su postgres -c "psql -tAc \\"select 1 from pg_roles where rolname='app'\\"" | grep -q 1 ||
  su postgres -c "psql -tAc \\"create role app with login superuser password 'app'\\""
su postgres -c "psql -tAc \\"select 1 from pg_database where datname='appdb'\\"" | grep -q 1 ||
  su postgres -c "createdb -O app appdb"

psql "${SANDBOX_DATABASE_URL}" -tAc 'select 1' >/dev/null
`;

/**
 * Bring up a real Postgres inside the sandbox and return the URL to reach it.
 *
 * Without one, a full-stack build is only ever exercised against an
 * unreachable database: the schema is never applied, the seed never loads, and
 * the first query to run for real runs in production. The sandbox image ships
 * the Postgres 18 client and the pgdg apt source already configured, so the
 * server itself is a ten-second install.
 */
export async function ensureSandboxPostgres(sandbox: Sandbox): Promise<string> {
	await sandbox.mustRun(START_POSTGRES, "Start Postgres in the sandbox");
	return SANDBOX_DATABASE_URL;
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
