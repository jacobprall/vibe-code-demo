const form = document.querySelector("#prompt-form");
const runPanel = document.querySelector("#run-panel");
const runList = document.querySelector("#run-list");
const emptyHistory = document.querySelector("#empty-history");
const refreshRuns = document.querySelector("#refresh-runs");
const status = document.querySelector("#status");
const activity = document.querySelector("#activity");
const stages = document.querySelector("#stages");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const resultName = document.querySelector("#result-name");
const webUrl = document.querySelector("#web-url");
const summary = document.querySelector("#summary");
const runDetails = document.querySelector("#run-details");
const submit = form.querySelector("button");

const stageOrder = [
	"designing",
	"provisioning",
	"curating",
	"building",
	"verifying",
	"publishing",
	"waiting_for_services",
	"waiting_for_deploys",
	"smoke_testing",
	"done",
];

let runs = [];
let selectedRunId = null;
let pollGeneration = 0;

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	setBusy(true);
	runPanel.hidden = false;
	status.textContent = "Submitting prompt";

	try {
		const response = await fetch("/ui/apps", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: form.prompt.value }),
		});
		const body = await response.json();
		if (!response.ok || !body.runId) {
			throw new Error(body.detail || body.error || `Request failed (${response.status})`);
		}
		form.reset();
		await loadRuns(body.runId);
	} catch (error) {
		showFailure(error instanceof Error ? error.message : String(error));
	}
});

refreshRuns.addEventListener("click", () => {
	loadRuns(selectedRunId).catch((error) => showFailure(error.message));
});

async function loadRuns(preferredRunId) {
	const response = await fetch("/ui/apps");
	if (!response.ok) throw new Error(`Could not load run history (${response.status})`);
	const body = await response.json();
	runs = body.runs || [];
	renderHistory();

	const nextRunId =
		(preferredRunId && runs.some((run) => run.runId === preferredRunId)
			? preferredRunId
			: null) ||
		(selectedRunId && runs.some((run) => run.runId === selectedRunId)
			? selectedRunId
			: null) ||
		runs[0]?.runId;
	if (nextRunId) await selectRun(nextRunId);
}

function renderHistory() {
	emptyHistory.hidden = runs.length > 0;
	runList.replaceChildren(
		...runs.map((run) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = `run-item${run.runId === selectedRunId ? " selected" : ""}`;
			button.dataset.runId = run.runId;
			button.setAttribute("aria-pressed", String(run.runId === selectedRunId));

			const name = document.createElement("strong");
			name.textContent = run.appName || truncate(run.prompt, 34);
			const meta = document.createElement("span");
			meta.textContent = `${label(run.status)} · ${formatDate(run.createdAt)}`;
			button.append(name, meta);
			button.addEventListener("click", () => selectRun(run.runId));
			return button;
		}),
	);
}

async function selectRun(runId) {
	selectedRunId = runId;
	localStorage.setItem("vibe-code-selected-run", runId);
	pollGeneration += 1;
	const generation = pollGeneration;
	renderHistory();
	await poll(runId, generation);
}

async function poll(runId, generation) {
	while (generation === pollGeneration && runId === selectedRunId) {
		const response = await fetch(`/ui/apps/${encodeURIComponent(runId)}`);
		if (!response.ok) throw new Error(`Status check failed (${response.status})`);
		const run = await response.json();
		upsertRun(run);
		renderRun(run);
		renderHistory();
		if (run.status !== "running") return;
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
}

function upsertRun(run) {
	const index = runs.findIndex((candidate) => candidate.runId === run.runId);
	if (index === -1) runs.unshift(run);
	else runs[index] = run;
}

function renderRun(run) {
	runPanel.hidden = false;
	runPanel.classList.toggle(
		"failed",
		!["running", "deployed", "awaiting_blueprint"].includes(run.status),
	);
	status.textContent =
		run.status === "running" ? label(run.stage || "queued") : label(run.status);
	progress.textContent = run.progress || "";
	activity.hidden = run.status !== "running";
	setBusy(run.status === "running");

	const current = stageOrder.indexOf(run.stage);
	stages.replaceChildren(
		...stageOrder.map((stage, index) => {
			const item = document.createElement("li");
			item.textContent = label(stage);
			if (index < current || run.status === "deployed") item.className = "complete";
			if (index === current && run.status === "running") item.className = "active";
			if (
				index === current &&
				!["running", "deployed", "awaiting_blueprint"].includes(run.status)
			) {
				item.className = "failed-stage";
			}
			return item;
		}),
	);

	const deployed = run.status === "deployed" && Boolean(run.urls?.web);
	result.hidden = !deployed;
	if (deployed) {
		resultName.textContent = titleFromSlug(run.appName) || "Your website";
		summary.textContent = resultSummary(run.summary);
		webUrl.href = run.urls.web;
	}

	const showDetails =
		run.status !== "running" &&
		run.status !== "deployed" &&
		Boolean(run.summary);
	runDetails.hidden = !showDetails;
	runDetails.textContent = showDetails ? run.summary : "";
}

function setBusy(busy) {
	submit.disabled = busy;
	submit.textContent = busy ? "Building…" : "Build and deploy";
}

function showFailure(message) {
	runPanel.hidden = false;
	runPanel.classList.add("failed");
	status.textContent = "Request failed";
	progress.textContent = message;
	setBusy(false);
}

function label(value) {
	return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncate(value, length) {
	return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function titleFromSlug(value) {
	return value ? label(value.replaceAll("-", " ")) : "";
}

function resultSummary(value) {
	if (!value) return "Your website is ready.";
	const built = value.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
	return truncate(built, 220);
}

function formatDate(value) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

loadRuns(localStorage.getItem("vibe-code-selected-run")).catch((error) =>
	showFailure(error.message),
);
