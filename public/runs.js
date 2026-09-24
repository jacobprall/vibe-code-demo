/**
 * What the two views of the UI share: the prompt form, the history of runs,
 * the poll of the selected run, the run panel, the stages, and the delete
 * dialog. The two pages use the same IDs for these elements. Each view renders
 * its own history, and it can add to the run panel.
 */

/** A task still owns these runs, so the page keeps polling them. */
export const activeStatuses = ["running", "deleting"];
const healthyStatuses = [...activeStatuses, "deployed", "awaiting_blueprint"];

/**
 * Start the page. `view.renderHistory(runs, selectedRunId, actions)` renders
 * the history, and `view.renderRun(run, actions)`, if the view has it, adds to
 * the run panel. `actions`, which this also returns, has `select(runId)` and
 * `openDeleteDialog(run)`.
 */
export function startRunsPage(view) {
	const form = document.querySelector("#prompt-form");
	const runPanel = document.querySelector("#run-panel");
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
	const deleteDialog = document.querySelector("#delete-dialog");
	const deleteForm = document.querySelector("#delete-form");
	const deleteTitle = document.querySelector("#delete-title");
	const deleteDescription = document.querySelector("#delete-description");
	const deleteConfirmField = document.querySelector("#delete-confirm-field");
	const deleteAppName = document.querySelector("#delete-app-name");
	const deleteConfirm = document.querySelector("#delete-confirm");
	const deleteSubmit = document.querySelector("#delete-submit");
	const deleteCancel = document.querySelector("#delete-cancel");

	/**
	 * The stages are static HTML. A poll changes only the class of each stage.
	 * It does not replace the stages, so the live region of the run panel
	 * does not read them again, and a focused stage keeps the focus.
	 */
	const stageItems = [...stages.querySelectorAll("[data-stage]")];
	const stageOrder = stageItems.map((item) => item.dataset.stage);

	const actions = { select: selectRun, openDeleteDialog };
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

	deleteConfirm.addEventListener("input", () => {
		deleteSubmit.disabled =
			deleteConfirm.value.trim() !== deleteForm.dataset.appName;
	});

	deleteCancel.addEventListener("click", () => deleteDialog.close());

	deleteForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		deleteDialog.close();
		try {
			await deleteRun(deleteForm.dataset.runId);
		} catch (error) {
			showFailure(error instanceof Error ? error.message : String(error));
		}
	});

	/**
	 * An app is deleted on Render and in the apps repository, with all of its
	 * runs, and the delete cannot be undone. So the dialog asks for the app's
	 * name, as hosting dashboards do before such a delete.
	 */
	function openDeleteDialog(run) {
		const appName = run.appName || "";
		deleteForm.dataset.runId = run.runId;
		deleteForm.dataset.appName = appName;
		deleteTitle.textContent = appName
			? `Delete ${titleFromSlug(appName)}?`
			: "Delete this run?";
		deleteDescription.textContent = appName
			? "This deletes the app's services and databases on Render, with all their data, " +
				"and removes its files from the apps repository. Every run of this app leaves your " +
				"history. You cannot undo this."
			: "This run did not create an app, so only the run leaves your history.";
		deleteConfirmField.hidden = !appName;
		deleteAppName.textContent = appName;
		deleteConfirm.value = "";
		deleteSubmit.disabled = Boolean(appName);
		deleteDialog.showModal();
		(appName ? deleteConfirm : deleteSubmit).focus();
	}

	async function deleteRun(runId) {
		const response = await fetch(`/ui/apps/${encodeURIComponent(runId)}`, {
			method: "DELETE",
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(body.error || `Delete failed (${response.status})`);
		}
		if (body.status === "deleted") {
			await runRemoved();
			return;
		}
		// Every run of the app is deleting now, so read them all again.
		await loadRuns(runId);
	}

	/** The run is gone: a delete finished, or the run had no app to delete. */
	async function runRemoved() {
		selectedRunId = null;
		pollGeneration += 1;
		runPanel.hidden = true;
		await loadRuns();
	}

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
		view.renderHistory(runs, selectedRunId, actions);
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
			if (generation !== pollGeneration) return;
			// A delete that finished removed the run.
			if (response.status === 404) {
				await runRemoved();
				return;
			}
			if (!response.ok) throw new Error(`Status check failed (${response.status})`);
			const run = await response.json();
			upsertRun(run);
			renderRun(run);
			renderHistory();
			if (!activeStatuses.includes(run.status)) return;
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
		runPanel.classList.toggle("failed", !healthyStatuses.includes(run.status));
		status.textContent =
			run.status === "running" ? label(run.stage || "queued") : label(run.status);
		progress.textContent = run.progress || "";
		activity.hidden = !activeStatuses.includes(run.status);
		setBusy(run.status === "running");
		// The stages are those of a build, so a delete does not show them.
		stages.hidden = ["deleting", "delete_failed"].includes(run.status);

		const current = stageOrder.indexOf(run.stage);
		stageItems.forEach((item, index) => {
			let state = "";
			if (index < current || run.status === "deployed") state = "complete";
			if (index === current && run.status === "running") state = "active";
			if (
				index === current &&
				!["running", "deployed", "awaiting_blueprint"].includes(run.status)
			) {
				state = "failed-stage";
			}
			item.className = state;
		});

		const deployed = run.status === "deployed" && Boolean(run.urls?.web);
		result.hidden = !deployed;
		if (deployed) {
			resultName.textContent = titleFromSlug(run.appName) || "Your website";
			summary.textContent = resultSummary(run.summary);
			webUrl.href = run.urls.web;
		}

		const showDetails =
			!activeStatuses.includes(run.status) &&
			run.status !== "deployed" &&
			Boolean(run.summary);
		runDetails.hidden = !showDetails;
		runDetails.textContent = showDetails ? run.summary : "";

		view.renderRun?.(run, actions);
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

	loadRuns(localStorage.getItem("vibe-code-selected-run")).catch((error) =>
		showFailure(error.message),
	);
	return actions;
}

export function label(value) {
	return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function truncate(value, length) {
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

export function formatDate(value) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}
