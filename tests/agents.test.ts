/**
 * Tool access is the security boundary between an agent and the machine.
 * These assertions are what stop the curator from gaining shell access and
 * the architect from provisioning infrastructure.
 */
import { describe, expect, it } from "vitest";
import * as agents from "../app/agents.js";
import type { Agent } from "../app/claude.js";
import { isRenderReadOnlyTool } from "../app/policy.js";

const all: Agent[] = [
	agents.architect,
	agents.curator,
	agents.builder,
	agents.deployManager,
];

const toolNames = (agent: Agent) => (agent.tools ?? []).map((tool) => tool.name);

describe("agent definitions", () => {
	it("registers four agents with unique ids", () => {
		expect(new Set(all.map((agent) => agent.id)).size).toBe(4);
	});

	it("gives every agent a prompt and a known model tier", () => {
		for (const agent of all) {
			expect(agent.prompt.length).toBeGreaterThan(0);
			expect(["small", "medium", "large"]).toContain(agent.model);
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

	it("gives the curator downloads and reads, but no shell or file writes", () => {
		expect(toolNames(agents.curator)).toContain("asset__search");
		expect(toolNames(agents.curator)).toContain("asset__fetch");
		expect(toolNames(agents.curator)).not.toContain("sandbox__exec");
		expect(toolNames(agents.curator)).not.toContain("sandbox__write_file");
		expect(toolNames(agents.curator)).not.toContain("sandbox__apply_patch");
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

	it("gives no agent but the builder write or exec tools", () => {
		for (const agent of all.filter((candidate) => candidate.id !== "builder")) {
			expect(toolNames(agent)).not.toContain("sandbox__exec");
			expect(toolNames(agent)).not.toContain("sandbox__write_file");
			expect(toolNames(agent)).not.toContain("sandbox__apply_patch");
		}
	});

	it("never lets an agent reach Render with anything but reads", () => {
		for (const agent of all) {
			for (const name of agent.renderTools ?? []) {
				expect(isRenderReadOnlyTool(name)).toBe(true);
			}
		}
	});

	// Claude's own Bash/Read/Write/Edit would bypass the workflow-owned sandbox.
	it("never grants a Claude built-in tool", () => {
		const builtIns = ["Bash", "Read", "Write", "Edit", "NotebookEdit"];
		for (const agent of all) {
			for (const name of toolNames(agent)) {
				expect(builtIns).not.toContain(name);
				expect(/^(sandbox|asset)__/.test(name)).toBe(true);
			}
		}
	});
});
