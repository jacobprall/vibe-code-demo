import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimRun: vi.fn(),
	finishRun: vi.fn(),
	getRun: vi.fn(),
	ping: vi.fn(),
	startTask: vi.fn(),
}));

vi.mock("../app/store.js", () => ({
	claimRun: mocks.claimRun,
	finishRun: mocks.finishRun,
	getRun: mocks.getRun,
	ping: mocks.ping,
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask: mocks.startTask };
	},
}));

const { createGateway } = await import("../app/gateway.js");

const KEY = "0123456789abcdef0123456789abcdef";
const PROMPT = "Create an online catalog to sell handcrafted furniture";

function post(body: unknown, opts: { key?: string | null } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? KEY}`;

	return createGateway().request("/v1/apps", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.claimRun.mockResolvedValue({ claimed: true });
	mocks.finishRun.mockResolvedValue(undefined);
	mocks.ping.mockResolvedValue(undefined);
	mocks.startTask.mockResolvedValue({ taskRunId: "trn-1" });

	process.env.AIRO_API_KEY = KEY;
	process.env.RENDER_WORKFLOW_SLUG = "wfs-1";
});

describe("health", () => {
	it("reports liveness without touching Postgres", async () => {
		const response = await createGateway().request("/health");
		expect(response.status).toBe(200);
		expect(mocks.ping).not.toHaveBeenCalled();
	});

	it("reports 503 when Postgres is unreachable", async () => {
		mocks.ping.mockRejectedValue(new Error("down"));
		const response = await createGateway().request("/ready");
		expect(response.status).toBe(503);
	});
});

describe("authentication", () => {
	it("rejects a request with no bearer token before claiming a run", async () => {
		const response = await post({ prompt: PROMPT }, { key: null });
		expect(response.status).toBe(401);
		expect(mocks.claimRun).not.toHaveBeenCalled();
	});

	it("rejects a wrong bearer token", async () => {
		const response = await post({ prompt: PROMPT }, { key: "nope" });
		expect(response.status).toBe(401);
	});

	it("rejects a body over the size cap", async () => {
		const response = await post(JSON.stringify({ padding: "x".repeat(70 * 1024) }));
		expect(response.status).toBe(413);
	});

	it("guards the status route too", async () => {
		const response = await createGateway().request(
			"/v1/apps/6f9619ff-8b86-d011-b42d-00cf4fc964ff",
		);
		expect(response.status).toBe(401);
		expect(mocks.getRun).not.toHaveBeenCalled();
	});
});

describe("validation", () => {
	it("rejects malformed JSON", async () => {
		const response = await post("{not json");
		expect(response.status).toBe(400);
	});

	it.each([
		["a prompt that is too short", { prompt: "hi" }],
		["no prompt at all", { user: "demo" }],
		["a user that is not a slug", { prompt: PROMPT, user: "../etc" }],
	])("rejects %s", async (_label, body) => {
		const response = await post(body);
		expect(response.status).toBe(400);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});
});

describe("dispatch", () => {
	it("claims the run and starts the workflow task", async () => {
		const response = await post({ prompt: PROMPT, user: "godaddy" });

		expect(response.status).toBe(202);
		expect(mocks.claimRun).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: PROMPT, user: "godaddy" }),
		);
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/prompt-to-app", [
			expect.objectContaining({ prompt: PROMPT, user: "godaddy" }),
		]);
	});

	it("returns the original run for a repeated idempotency key", async () => {
		mocks.claimRun.mockResolvedValue({
			claimed: false,
			reason: "duplicate",
			runId: "run-1",
		});
		const response = await post({ prompt: PROMPT, idempotencyKey: "same-key-1" });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			runId: "run-1",
			duplicate: true,
		});
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("refuses work when too many runs are already going", async () => {
		mocks.claimRun.mockResolvedValue({ claimed: false, reason: "at_capacity" });
		const response = await post({ prompt: PROMPT });

		expect(response.status).toBe(429);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("releases the claim when dispatch fails so a retry can succeed", async () => {
		mocks.startTask.mockRejectedValue(new Error("render unavailable"));
		const response = await post({ prompt: PROMPT });

		expect(response.status).toBe(502);
		expect(mocks.finishRun).toHaveBeenCalledWith(
			expect.any(String),
			"failed",
			expect.objectContaining({ summary: "dispatch failed" }),
		);
	});

	it("fails when the workflow slug is not configured", async () => {
		process.env.RENDER_WORKFLOW_SLUG = "";
		const response = await post({ prompt: PROMPT });
		expect(response.status).toBe(502);
	});
});

describe("status", () => {
	it("returns the run, with secret-shaped text redacted", async () => {
		mocks.getRun.mockResolvedValue({
			id: "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
			idempotencyKey: "k",
			prompt: PROMPT,
			user: "demo",
			status: "deployed",
			stage: "done",
			appName: "furniture-catalog",
			webUrl: "https://airo-demo-furniture-catalog-web.onrender.com",
			apiUrl: "https://airo-demo-furniture-catalog-api.onrender.com",
			blueprintPath: "apps/demo/furniture-catalog/render.yaml",
			summary: "Wired DATABASE_URL postgres://user:pw@host/db for the API.",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:10:00.000Z",
		});

		const response = await createGateway().request(
			"/v1/apps/6f9619ff-8b86-d011-b42d-00cf4fc964ff",
			{ headers: { authorization: `Bearer ${KEY}` } },
		);
		const body = (await response.json()) as {
			urls: { web: string };
			summary: string;
		};

		expect(response.status).toBe(200);
		expect(body.urls.web).toContain("onrender.com");
		expect(body.summary).not.toContain("postgres://user:pw@host/db");
		expect(body.summary).toContain("[REDACTED]");
	});

	it("404s an id that is not a run id without querying Postgres", async () => {
		const response = await createGateway().request("/v1/apps/not-a-uuid", {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(response.status).toBe(404);
		expect(mocks.getRun).not.toHaveBeenCalled();
	});
});
