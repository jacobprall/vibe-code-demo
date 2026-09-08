const form = document.querySelector("#prompt-form");
const runPanel = document.querySelector("#run-panel");
const status = document.querySelector("#status");
const activity = document.querySelector("#activity");
const stages = document.querySelector("#stages");
const progress = document.querySelector("#progress");
const result = document.querySelector("#result");
const webUrl = document.querySelector("#web-url");
const apiUrl = document.querySelector("#api-url");
const summary = document.querySelector("#summary");
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

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	resetRun();
	setBusy(true);
	runPanel.hidden = false;
	status.textContent = "Submitting prompt";

	try {
		const response = await fetch("/ui/apps", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				prompt: form.prompt.value,
			}),
		});
		const body = await response.json();
		if (!response.ok || !body.runId) {
			throw new Error(body.detail || body.error || `Request failed (${response.status})`);
		}
		localStorage.setItem("vibe-code-run", body.runId);
		await poll(body.runId);
	} catch (error) {
		showFailure(error instanceof Error ? error.message : String(error));
	}
});

async function poll(runId) {
	while (true) {
		const response = await fetch(`/ui/apps/${encodeURIComponent(runId)}`);
		if (!response.ok) throw new Error(`Status check failed (${response.status})`);
		const run = await response.json();
		renderRun(run);
		if (run.status !== "running") {
			localStorage.removeItem("vibe-code-run");
			setBusy(false);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
}

function renderRun(run) {
	runPanel.hidden = false;
	status.textContent =
		run.status === "running" ? label(run.stage || "queued") : label(run.status);
	progress.textContent = run.progress || "";
	activity.hidden = run.status !== "running";

	const current = stageOrder.indexOf(run.stage);
	stages.replaceChildren(
		...stageOrder.map((stage, index) => {
			const item = document.createElement("li");
			item.textContent = label(stage);
			if (index < current || run.status !== "running") item.className = "complete";
			if (index === current && run.status === "running") item.className = "active";
			return item;
		}),
	);

	if (run.urls?.web) {
		result.hidden = false;
		webUrl.href = run.urls.web;
		webUrl.textContent =
			run.status === "deployed" ? "Open deployed app" : "Preview live service";
	}
	if (run.urls?.api) {
		apiUrl.hidden = false;
		apiUrl.href = run.urls.api;
	}
	if (run.summary) {
		summary.hidden = false;
		summary.textContent = run.summary;
	}
	if (run.status !== "running" && run.status !== "deployed") {
		runPanel.classList.add("failed");
	}
}

function resetRun() {
	runPanel.classList.remove("failed");
	result.hidden = true;
	apiUrl.hidden = true;
	summary.hidden = true;
	progress.textContent = "";
	stages.replaceChildren();
}

function setBusy(busy) {
	submit.disabled = busy;
	submit.textContent = busy ? "Building…" : "Build and deploy";
	activity.hidden = !busy;
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

const savedRun = localStorage.getItem("vibe-code-run");
if (savedRun) {
	runPanel.hidden = false;
	setBusy(true);
	poll(savedRun).catch((error) => showFailure(error.message));
}
