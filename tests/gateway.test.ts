import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimDelete: vi.fn(),
	claimRun: vi.fn(),
	claimWorkflowCheck: vi.fn(),
	deleteRunWithoutApp: vi.fn(),
	failDelete: vi.fn(),
	finishRun: vi.fn(),
	getRun: vi.fn(),
	listRunsByUser: vi.fn(),
	ping: vi.fn(),
	setDeleteWorkflowRunId: vi.fn(),
	setWorkflowRunId: vi.fn(),
	startTask: vi.fn(),
	getTaskRun: vi.fn(),
	workflowIdOfTaskRun: vi.fn(),
}));

vi.mock("../app/store.js", () => ({
	claimDelete: mocks.claimDelete,
	claimRun: mocks.claimRun,
	claimWorkflowCheck: mocks.claimWorkflowCheck,
	deleteRunWithoutApp: mocks.deleteRunWithoutApp,
	failDelete: mocks.failDelete,
	finishRun: mocks.finishRun,
	getRun: mocks.getRun,
	listRunsByUser: mocks.listRunsByUser,
	ping: mocks.ping,
	setDeleteWorkflowRunId: mocks.setDeleteWorkflowRunId,
	setWorkflowRunId: mocks.setWorkflowRunId,
}));

vi.mock("../app/render.js", () => ({
	workflowIdOfTaskRun: mocks.workflowIdOfTaskRun,
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = {
			startTask: mocks.startTask,
			getTaskRun: mocks.getTaskRun,
		};
	},
}));

const { createGateway } = await import("../app/gateway.js");

const KEY = "0123456789abcdef0123456789abcdef";
const PROMPT = "Create an online catalog to sell handcrafted furniture";
const RUN_ID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const UI_AUTH = `Basic ${Buffer.from("demo:a-long-demo-password").toString("base64")}`;

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
	mocks.claimDelete.mockResolvedValue({ claimed: true, runIds: [RUN_ID] });
	mocks.deleteRunWithoutApp.mockResolvedValue(true);
	mocks.failDelete.mockResolvedValue(undefined);
	mocks.setDeleteWorkflowRunId.mockResolvedValue(undefined);
	mocks.finishRun.mockResolvedValue(undefined);
	mocks.listRunsByUser.mockResolvedValue([]);
	mocks.ping.mockResolvedValue(undefined);
	mocks.startTask.mockResolvedValue({ taskRunId: "trn-1" });
	mocks.claimWorkflowCheck.mockResolvedValue(false);
	mocks.setWorkflowRunId.mockResolvedValue(undefined);
	mocks.workflowIdOfTaskRun.mockResolvedValue("wfl-1");

	process.env.FACTORY_API_KEY = KEY;
	process.env.UI_USERNAME = "demo";
	process.env.UI_PASSWORD = "a-long-demo-password";
	process.env.RENDER_WORKFLOW_SLUG = "wfs-1";
	delete process.env.UI_AUTH_DISABLED;
	delete process.env.NODE_ENV;
	delete process.env.RENDER_USE_LOCAL_DEV;
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

	// RFC 6750 gives 400 for a header that is not a bearer token.
	it("rejects an authorization header that is not a bearer token", async () => {
		const response = await createGateway().request("/v1/apps", {
			method: "POST",
			headers: { authorization: UI_AUTH, "content-type": "application/json" },
			body: JSON.stringify({ prompt: PROMPT }),
		});
		expect(response.status).toBe(400);
		expect(mocks.claimRun).not.toHaveBeenCalled();
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
		const response = await post({ prompt: PROMPT, user: "demo" });

		expect(response.status).toBe(202);
		expect(mocks.claimRun).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: PROMPT, user: "demo" }),
		);
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/prompt-to-app", [
			expect.objectContaining({ prompt: PROMPT, user: "demo" }),
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

describe("browser UI", () => {
	const authorization = `Basic ${Buffer.from("demo:a-long-demo-password").toString("base64")}`;

	it("requires the UI username to be a namespace-safe slug", () => {
		process.env.UI_USERNAME = "Demo User";
		expect(() => createGateway()).toThrow(
			"UI_USERNAME must be a lowercase slug",
		);
	});

	it("requires Basic Auth for the page", async () => {
		const denied = await createGateway().request("/");
		expect(denied.status).toBe(401);

		const response = await createGateway().request("/", {
			headers: { authorization },
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<title>Vibe Code Demo</title>");
	});

	it("lists each run stage in order, with a tooltip that says where it runs", async () => {
		const { RUN_STAGES } =
			await vi.importActual<typeof import("../app/store.js")>("../app/store.js");
		const response = await createGateway().request("/", {
			headers: { authorization },
		});
		const items = [
			...(await response.text()).matchAll(/<li data-stage="([a-z_]+)">[\s\S]*?<\/li>/g),
		];

		expect(items.map(([, stage]) => stage)).toEqual(RUN_STAGES);
		for (const [item, stage] of items) {
			expect(item).toContain(`aria-describedby="stage-tip-${stage}"`);
			expect(item).toContain(`id="stage-tip-${stage}" class="stage-tip" role="tooltip"`);
			expect(item).toContain('<span class="eyebrow">Runs in</span>');
		}
	});

	it.each(["/table", "/table.js", "/runs.js", "/app.js"])(
		"requires Basic Auth for %s",
		async (path) => {
			expect((await createGateway().request(path)).status).toBe(401);
			const response = await createGateway().request(path, {
				headers: { authorization },
			});
			expect(response.status).toBe(200);
		},
	);

	it("explains each run stage in the table view, with its dashboard links", async () => {
		const { RUN_STAGES } =
			await vi.importActual<typeof import("../app/store.js")>("../app/store.js");
		const response = await createGateway().request("/table", {
			headers: { authorization },
		});
		const html = await response.text();
		const rows = [...html.matchAll(/<tr data-stage="([a-z_]+)">([\s\S]*?)<\/tr>/g)];

		expect(html).toContain('<a class="secondary-button view-switch" href="/">');
		expect(rows.map(([, stage]) => stage)).toEqual(RUN_STAGES);
		for (const [, , cells] of rows) {
			// The name, what the stage does, where it runs, and its links.
			const text = [...cells.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(
				([, content]) => content.replace(/<[^>]+>/g, "").trim(),
			);
			expect(text.slice(0, 3).every(Boolean)).toBe(true);
			expect(cells).toMatch(/<td class="stage-links" data-links="workflowRun( sandbox)?">/);
		}
	});

	it("allows the explicit auth bypass only outside production", async () => {
		process.env.UI_AUTH_DISABLED = "true";
		expect((await createGateway().request("/")).status).toBe(200);

		process.env.NODE_ENV = "production";
		expect((await createGateway().request("/")).status).toBe(401);
	});

	it("submits without exposing or requiring the factory bearer token", async () => {
		const response = await createGateway().request("/ui/apps", {
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify({ prompt: PROMPT, user: "another-user" }),
		});

		expect(response.status).toBe(202);
		expect(mocks.startTask).toHaveBeenCalledOnce();
		expect(mocks.claimRun).toHaveBeenCalledWith(
			expect.objectContaining({ user: "demo" }),
		);
		expect(mocks.setWorkflowRunId).toHaveBeenCalledWith(
			expect.any(String),
			"trn-1",
		);
		expect(await response.json()).toMatchObject({
			statusUrl: expect.stringMatching(/^\/ui\/apps\//),
		});
	});

	it("lists only runs in the authenticated UI namespace", async () => {
		const response = await createGateway().request("/ui/apps", {
			headers: { authorization },
		});

		expect(response.status).toBe(200);
		expect(mocks.listRunsByUser).toHaveBeenCalledWith("demo");
		expect(await response.json()).toEqual({ runs: [] });
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
			// Progress can hold the error of a failed Render read.
			progress:
				"The deploy lookup of srv-1 failed (attempt 1 of 5): postgres://user:pw@host/db",
			workflowRunId: "trn-1",
			appName: "furniture-catalog",
			webUrl: "https://vibe-demo-furniture-catalog-web.onrender.com",
			apiUrl: "https://vibe-demo-furniture-catalog-api.onrender.com",
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
			progress: string;
			summary: string;
		};

		expect(response.status).toBe(200);
		expect(body.urls.web).toContain("onrender.com");
		expect(body.summary).not.toContain("postgres://user:pw@host/db");
		expect(body.summary).toContain("[REDACTED]");
		expect(body.progress).toBe(
			"The deploy lookup of srv-1 failed (attempt 1 of 5): [REDACTED]",
		);
	});

	function readV1Run() {
		return createGateway().request(`/v1/apps/${RUN_ID}`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
	}

	// prompt-to-app writes its result before it returns.
	it("does not change the row of a task run that succeeded", async () => {
		mocks.getRun.mockResolvedValue(storedRun({ status: "running" }));
		mocks.claimWorkflowCheck.mockResolvedValue(true);
		mocks.getTaskRun.mockResolvedValue({ status: "succeeded", results: [] });

		expect((await readV1Run()).status).toBe(200);
		expect(mocks.getTaskRun).toHaveBeenCalledWith("trn-1");
		expect(mocks.finishRun).not.toHaveBeenCalled();
	});

	it("keeps a run running while its task run is paused", async () => {
		mocks.getRun.mockResolvedValue(storedRun({ status: "running" }));
		mocks.claimWorkflowCheck.mockResolvedValue(true);
		mocks.getTaskRun.mockResolvedValue({ status: "paused", results: [] });

		expect((await readV1Run()).status).toBe(200);
		expect(mocks.finishRun).not.toHaveBeenCalled();
	});

	// A timeout stops the task before its catch block can write the failure.
	it.each(["failed", "canceled"])(
		"marks a run failed when its task run is %s",
		async (status) => {
			mocks.getRun.mockResolvedValue(storedRun({ status: "running" }));
			mocks.claimWorkflowCheck.mockResolvedValue(true);
			mocks.getTaskRun.mockResolvedValue({ status, error: "timed out" });

			expect((await readV1Run()).status).toBe(200);
			expect(mocks.finishRun).toHaveBeenCalledWith(RUN_ID, "failed", {
				summary: `Workflow ${status}: timed out`,
			});
		},
	);

	/** Two reads of the run from one gateway, as the polls of the UI do. */
	async function readTwice() {
		const gateway = createGateway();
		const read = async () =>
			(await (
				await gateway.request(`/v1/apps/${RUN_ID}`, {
					headers: { authorization: `Bearer ${KEY}` },
				})
			).json()) as { finishedAt: string; links: Record<string, unknown> };
		return [await read(), await read()];
	}

	it("links the run to its task run and its sandbox in the Render Dashboard", async () => {
		mocks.getRun.mockResolvedValue(
			storedRun({ sandboxId: "sbx-1", sandboxGroupId: "sbg-1" }),
		);

		const [first, second] = await readTwice();

		// The workflow ID is read after the first response, and only once.
		expect(first.links.workflowRun).toBeNull();
		expect(mocks.workflowIdOfTaskRun).toHaveBeenCalledTimes(1);
		expect(mocks.workflowIdOfTaskRun).toHaveBeenCalledWith("trn-1");
		expect(second.finishedAt).toBe("2026-01-01T00:09:00.000Z");
		expect(second.links).toEqual({
			workflowRun: "https://dashboard.render.com/wf/wfl-1/runs/trn-1",
			sandbox: "https://dashboard.render.com/sandbox-group/sbg-1/sandboxes/sbx-1",
		});
	});

	it("gives no link that it cannot make", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.getRun.mockResolvedValue(storedRun({ sandboxId: "sbx-1" }));
		mocks.workflowIdOfTaskRun.mockRejectedValue(new Error("403"));

		const [, second] = await readTwice();
		logged.mockRestore();

		expect(second.links).toEqual({ workflowRun: null, sandbox: null });
		// A failed read is tried again after a minute, not on each poll.
		expect(mocks.workflowIdOfTaskRun).toHaveBeenCalledTimes(1);
	});

	// A local task run is not in the Dashboard.
	it("gives no workflow link in local development", async () => {
		process.env.RENDER_USE_LOCAL_DEV = "true";
		mocks.getRun.mockResolvedValue(storedRun());

		const [, second] = await readTwice();

		expect(second.links.workflowRun).toBeNull();
		expect(mocks.workflowIdOfTaskRun).not.toHaveBeenCalled();
	});

	it("404s an id that is not a run id without querying Postgres", async () => {
		const response = await createGateway().request("/v1/apps/not-a-uuid", {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(response.status).toBe(404);
		expect(mocks.getRun).not.toHaveBeenCalled();
	});
});

/** A stored run of the furniture catalog, with some fields replaced. */
function storedRun(overrides: Record<string, unknown> = {}) {
	return {
		id: RUN_ID,
		idempotencyKey: "k",
		prompt: PROMPT,
		user: "demo",
		status: "deployed",
		stage: "done",
		progress: null,
		workflowRunId: "trn-1",
		appName: "furniture-catalog",
		webUrl: "https://vibe-demo-furniture-catalog-web.onrender.com",
		apiUrl: null,
		blueprintPath: "apps/demo/furniture-catalog/render.yaml",
		summary: "Deployed.",
		sandboxId: null,
		sandboxGroupId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		finishedAt: "2026-01-01T00:09:00.000Z",
		...overrides,
	};
}

function deleteV1(opts: { key?: string | null } = {}) {
	const headers: Record<string, string> = {};
	if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? KEY}`;
	return createGateway().request(`/v1/apps/${RUN_ID}`, {
		method: "DELETE",
		headers,
	});
}

/**
 * A delete removes the app on Render and in the apps repository, and every run
 * of the app. The gateway only claims the runs and dispatches delete-app.
 */
describe("delete", () => {
	beforeEach(() => {
		mocks.getRun.mockResolvedValue(storedRun());
		mocks.startTask.mockResolvedValue({ taskRunId: "trn-delete" });
	});

	it("rejects a request with no bearer token before reading the run", async () => {
		const response = await deleteV1({ key: null });
		expect(response.status).toBe(401);
		expect(mocks.getRun).not.toHaveBeenCalled();
	});

	it("404s a run that does not exist", async () => {
		mocks.getRun.mockResolvedValue(null);
		const response = await deleteV1();
		expect(response.status).toBe(404);
		expect(mocks.claimDelete).not.toHaveBeenCalled();
	});

	it("claims every run of the app and dispatches delete-app", async () => {
		mocks.claimDelete.mockResolvedValue({
			claimed: true,
			runIds: [RUN_ID, "run-older"],
		});

		const response = await deleteV1();

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			runId: RUN_ID,
			status: "deleting",
			appName: "furniture-catalog",
			runIds: [RUN_ID, "run-older"],
			statusUrl: `/v1/apps/${RUN_ID}`,
		});
		expect(mocks.claimDelete).toHaveBeenCalledWith("demo", "furniture-catalog");
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/delete-app", [
			{ user: "demo", appName: "furniture-catalog" },
		]);
		expect(mocks.setDeleteWorkflowRunId).toHaveBeenCalledWith(
			"demo",
			"furniture-catalog",
			"trn-delete",
		);
	});

	// The running run would publish the app again after the delete.
	it("refuses while a run of the app is still running", async () => {
		mocks.claimDelete.mockResolvedValue({ claimed: false, reason: "running" });
		const response = await deleteV1();
		expect(response.status).toBe(409);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("starts no second task while a delete is in progress", async () => {
		mocks.claimDelete.mockResolvedValue({
			claimed: false,
			reason: "deleting",
			runIds: [RUN_ID],
		});
		const response = await deleteV1();
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ status: "deleting" });
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("marks the runs delete_failed when dispatch fails, so a retry can start", async () => {
		mocks.startTask.mockRejectedValue(new Error("render unavailable"));
		const response = await deleteV1();
		expect(response.status).toBe(502);
		expect(mocks.failDelete).toHaveBeenCalledWith(
			"demo",
			"furniture-catalog",
			expect.stringContaining("Nothing was deleted"),
		);
	});

	it("deletes a run that chose no app at once, without a task", async () => {
		mocks.getRun.mockResolvedValue(
			storedRun({ status: "failed", appName: null, blueprintPath: null }),
		);
		const response = await deleteV1();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ runId: RUN_ID, status: "deleted" });
		expect(mocks.deleteRunWithoutApp).toHaveBeenCalledWith(RUN_ID);
		expect(mocks.claimDelete).not.toHaveBeenCalled();
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("refuses a run that chose no app yet and is still running", async () => {
		mocks.getRun.mockResolvedValue(
			storedRun({ status: "running", appName: null, blueprintPath: null }),
		);
		mocks.deleteRunWithoutApp.mockResolvedValue(false);
		const response = await deleteV1();
		expect(response.status).toBe(409);
	});

	describe("from the browser UI", () => {
		function deleteUi(
			headers: Record<string, string> = { authorization: UI_AUTH },
		) {
			return createGateway().request(`/ui/apps/${RUN_ID}`, {
				method: "DELETE",
				headers,
			});
		}

		it("requires Basic Auth", async () => {
			const response = await deleteUi({});
			expect(response.status).toBe(401);
			expect(mocks.getRun).not.toHaveBeenCalled();
		});

		it("deletes a run in the UI namespace without the factory bearer token", async () => {
			const response = await deleteUi();
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				statusUrl: `/ui/apps/${RUN_ID}`,
			});
		});

		it("404s a run in a different namespace", async () => {
			mocks.getRun.mockResolvedValue(storedRun({ user: "acme" }));
			const response = await deleteUi();
			expect(response.status).toBe(404);
			expect(mocks.claimDelete).not.toHaveBeenCalled();
			expect(mocks.startTask).not.toHaveBeenCalled();
		});
	});

	describe("status", () => {
		function readV1() {
			return createGateway().request(`/v1/apps/${RUN_ID}`, {
				headers: { authorization: `Bearer ${KEY}` },
			});
		}

		it("marks the runs delete_failed when the delete task failed", async () => {
			mocks.getRun.mockResolvedValue(
				storedRun({ status: "deleting", workflowRunId: "trn-delete" }),
			);
			mocks.claimWorkflowCheck.mockResolvedValue(true);
			mocks.getTaskRun.mockResolvedValue({ status: "failed", error: "boom" });

			const response = await readV1();

			expect(response.status).toBe(200);
			expect(mocks.getTaskRun).toHaveBeenCalledWith("trn-delete");
			// Only the runs of this task: a newer delete can own them now.
			expect(mocks.failDelete).toHaveBeenCalledWith(
				"demo",
				"furniture-catalog",
				"Delete failed: boom",
				"trn-delete",
			);
			expect(mocks.finishRun).not.toHaveBeenCalled();
		});

		it("404s a run that a finished delete removed", async () => {
			mocks.getRun
				.mockResolvedValueOnce(
					storedRun({ status: "deleting", workflowRunId: "trn-delete" }),
				)
				.mockResolvedValue(null);
			mocks.claimWorkflowCheck.mockResolvedValue(true);
			mocks.getTaskRun.mockResolvedValue({ status: "succeeded", results: [] });

			const response = await readV1();

			expect(response.status).toBe(404);
			expect(mocks.failDelete).not.toHaveBeenCalled();
		});
	});
});
