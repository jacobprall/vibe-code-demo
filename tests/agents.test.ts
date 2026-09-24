/**
 * Tool access is the security boundary between an agent and the machine.
 * These assertions are what keep the sandbox tools with the builder, and the
 * architect from provisioning infrastructure.
 */
import { describe, expect, it } from "vitest";
import * as agents from "../app/agents.js";
import type { Agent } from "../app/claude.js";
import { isRenderReadOnlyTool } from "../app/policy.js";

const all: Agent[] = [agents.architect, agents.builder, agents.deployManager];

const toolNames = (agent: Agent) => (agent.tools ?? []).map((tool) => tool.name);

describe("agent definitions", () => {
	it("registers three agents with unique ids", () => {
		expect(new Set(all.map((agent) => agent.id)).size).toBe(3);
	});

	it("gives every agent a prompt and a known model tier", () => {
		for (const agent of all) {
			expect(agent.prompt.length).toBeGreaterThan(0);
			expect(["medium", "large"]).toContain(agent.model);
		}
	});

	it("runs Sonnet agents at low effort", () => {
		for (const agent of all.filter((candidate) => candidate.model === "medium")) {
			expect(agent.effort).toBe("low");
		}
	});

	it("keeps ordinary websites on the fast static path", () => {
		expect(agents.architect.prompt).toContain(
			"Default to only a static_site for websites",
		);
		expect(agents.architect.prompt).toMatch(
			/A catalog alone\s+does not justify an API or database/,
		);
		expect(agents.builder.prompt).toContain(
			"dependency-free HTML, CSS, and JavaScript",
		);
		expect(agents.builder.prompt).toContain(
			"one user-facing sentence, at most 200 characters",
		);
	});

	// Verification deletes ignored files before it builds. A builder that does
	// not know this keeps source in dist/ and loses it.
	it("tells the builder that build output is not committed", () => {
		expect(agents.builder.prompt).toMatch(
			/deletes every ignored file before it builds/,
		);
		expect(agents.builder.prompt).toMatch(
			/buildCommand must\s+install the dependencies and write the\s+build output/,
		);
	});
});

describe("tool access", () => {
	it("gives the architect no sandbox tools at all", () => {
		expect(toolNames(agents.architect)).toEqual([]);
	});

	it("gives the architect only read-only Render tools", () => {
		const granted = agents.architect.renderTools ?? [];
		expect(granted.length).toBeGreaterThan(0);
		for (const name of granted) {
			expect(isRenderReadOnlyTool(name)).toBe(true);
		}
	});

	it("gives the deploy-manager no sandbox tools, only read-only Render tools", () => {
		expect(toolNames(agents.deployManager)).toEqual([]);
		const granted = agents.deployManager.renderTools ?? [];
		expect(granted.length).toBeGreaterThan(0);
		for (const name of granted) {
			expect(isRenderReadOnlyTool(name)).toBe(true);
		}
	});

	it("gives the builder read + write tools", () => {
		expect(toolNames(agents.builder)).toContain("sandbox__exec");
		expect(toolNames(agents.builder)).toContain("sandbox__write_file");
		expect(toolNames(agents.builder)).toContain("sandbox__read_file");
	});

	it("gives no agent but the builder a sandbox tool", () => {
		for (const agent of all.filter((candidate) => candidate.id !== "builder")) {
			expect(toolNames(agent)).toEqual([]);
		}
	});

	it("never lets an agent reach Render with anything but reads", () => {
		for (const agent of all) {
			for (const name of agent.renderTools ?? []) {
				expect(isRenderReadOnlyTool(name)).toBe(true);
			}
		}
	});

	// Logs can hold secrets. Workflow code reads the logs of a failed deploy
	// and redacts them before an agent gets them.
	it("gives no agent a Render tool that reads logs", () => {
		for (const agent of all) {
			expect(agent.renderTools ?? []).not.toContain("list_logs");
			expect(agent.renderTools ?? []).not.toContain("list_log_label_values");
		}
	});

	it("tells the deploy manager that its instructions hold the logs", () => {
		expect(agents.deployManager.prompt).toMatch(
			/the last lines of the\s+logs of that deploy/,
		);
		expect(agents.deployManager.prompt).toMatch(
			/Your Render tools cannot read logs\./,
		);
	});

	// Claude's own Bash/Read/Write/Edit would bypass the workflow-owned sandbox.
	it("never grants a Claude built-in tool", () => {
		const builtIns = ["Bash", "Read", "Write", "Edit", "NotebookEdit"];
		for (const agent of all) {
			for (const name of toolNames(agent)) {
				expect(builtIns).not.toContain(name);
				expect(name.startsWith("sandbox__")).toBe(true);
			}
		}
	});
});
