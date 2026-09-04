import { describe, expect, it, vi } from "vitest";
import { pushVerified } from "../app/git.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";

const OK: ExecResult = { output: "", exitCode: 0 };
const HEAD = "a".repeat(40);

/**
 * A sandbox that answers git from a handler and records every command, so a
 * test can assert on the sequence the push actually ran. Unmatched commands
 * succeed silently, which is what the uninteresting plumbing does.
 */
function fakeSandbox(handler: (command: string) => ExecResult | undefined) {
	const commands: string[] = [];

	const run = vi.fn(async (command: string): Promise<ExecResult> => {
		commands.push(command);
		return handler(command) ?? OK;
	});

	const sandbox = {
		run,
		upload: vi.fn(async () => undefined),
		async mustRun(command: string, label: string): Promise<string> {
			const result = await run(command);
			if (result.exitCode !== 0) throw new Error(`${label} failed`);
			return result.output;
		},
	} as unknown as Sandbox;

	return { sandbox, commands };
}

const isPush = (command: string) => / 'push' /.test(command);
const isPull = (command: string) => / 'pull' /.test(command);
const isConflictList = (command: string) =>
	command.includes("--diff-filter=U");

/** Answers for the verification that follows a successful push. */
function verified(command: string): ExecResult | undefined {
	if (command.includes("rev-parse HEAD")) {
		return { output: `${HEAD}\n`, exitCode: 0 };
	}
	if (command.includes("ls-remote")) {
		return { output: `${HEAD}\trefs/heads/main\n`, exitCode: 0 };
	}
	return undefined;
}

const push = (sandbox: Sandbox, resolve?: () => Promise<readonly string[]>) =>
	pushVerified(sandbox, "token", "https://github.com/o/r.git", "main", resolve);

/**
 * The root Blueprint holds every app the factory has built, so a concurrent
 * run's push makes it conflict every time. It is generated from each app's
 * airo.json, so it is recomputed rather than merged — without this, the run
 * that lost the race failed after building and verifying an app successfully.
 */
describe("pushVerified rebase conflicts", () => {
	it("recomputes a generated file and continues the rebase", async () => {
		let rebased = false;
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPull(command)) {
				rebased = true;
				return { output: "CONFLICT (content): render.yaml", exitCode: 1 };
			}
			// The retry lands once our commit sits on top of theirs.
			if (isPush(command)) {
				return rebased ? OK : { output: "non-fast-forward", exitCode: 1 };
			}
			if (isConflictList(command)) {
				return { output: "render.yaml\n", exitCode: 0 };
			}
			return verified(command);
		});

		const resolve = vi.fn(async () => ["render.yaml"]);
		await expect(push(sandbox, resolve)).resolves.toBe(HEAD);

		expect(resolve).toHaveBeenCalledOnce();
		expect(commands.some((c) => c.includes("rebase --continue"))).toBe(true);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(false);
	});

	it("names the file and aborts when a real conflict is mixed in", async () => {
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPush(command)) return { output: "non-fast-forward", exitCode: 1 };
			if (isPull(command)) return { output: "CONFLICT", exitCode: 1 };
			if (isConflictList(command)) {
				return {
					output: "render.yaml\napps/demo/shop/index.html\n",
					exitCode: 0,
				};
			}
			return verified(command);
		});

		await expect(push(sandbox, async () => ["render.yaml"])).rejects.toThrow(
			/apps\/demo\/shop\/index\.html/,
		);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(true);
	});

	it("aborts rather than leaving a rebase in progress with no resolver", async () => {
		const { sandbox, commands } = fakeSandbox((command) => {
			if (isPush(command)) return { output: "non-fast-forward", exitCode: 1 };
			if (isPull(command)) return { output: "CONFLICT", exitCode: 1 };
			return verified(command);
		});

		await expect(push(sandbox)).rejects.toThrow(/Rebase onto main failed/);
		expect(commands.some((c) => c.includes("rebase --abort"))).toBe(true);
	});

	it("does not touch the resolver when the first push succeeds", async () => {
		const { sandbox, commands } = fakeSandbox(verified);
		const resolve = vi.fn(async () => ["render.yaml"]);

		await expect(push(sandbox, resolve)).resolves.toBe(HEAD);
		expect(resolve).not.toHaveBeenCalled();
		expect(commands.some((c) => isPull(c))).toBe(false);
	});

	it("still refuses a remote SHA that does not match the local commit", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.includes("rev-parse HEAD")) {
				return { output: `${HEAD}\n`, exitCode: 0 };
			}
			if (command.includes("ls-remote")) {
				return { output: `${"b".repeat(40)}\trefs/heads/main\n`, exitCode: 0 };
			}
			return undefined;
		});

		await expect(push(sandbox)).rejects.toThrow(/does not match/);
	});
});
