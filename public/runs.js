/**
 * What the two views of the UI share: the prompt form, the history of runs,
 * the refresh of the runs, the run panel, the stages, and the delete dialog.
 * The two pages use the same IDs for these elements. Each view renders its
 * own history, and it can add to the run panel.
 */

/** A task still owns these runs, so the page keeps reading them. */
export const activeStatuses = ["running", "deleting"];
const healthyStatuses = [...activeStatuses, "deployed", "awaiting_blueprint"];
/** How long the page waits before it reads the runs again. */
const REFRESH_MS = 5000;

/**
 * Start the page. `view.renderHistory(runs, selectedRunId, actions)` renders
 * the history, and `view.renderRun(run, actions)`, if the view has it, adds to
 * the run panel. `actions`, which this also returns, has `select(runId)` and
 * `openDeleteDialog(run)`. A control in the history that has
 * `data-focus-key` gets the focus again after the history renders.
 */
export function startRunsPage(view) {
	const form = document.querySelector("#prompt-form");
	const formError = document.querySelector("#form-error");
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
	const deleteError = document.querySelector("#delete-error");
	const deleteSubmit = document.querySelector("#delete-submit");
	const deleteCancel = document.querySelector("#delete-cancel");

	/**
	 * The stages are static HTML. A refresh changes only the class of each
	 * stage. It does not replace the stages, so the live region of the run
	 * panel does not read them again, and a focused stage keeps the focus.
	 */
	const stageItems = [...stages.querySelectorAll("[data-stage]")];
	const stageOrder = stageItems.map((item) => item.dataset.stage);

	const actions = { select: selectRun, openDeleteDialog };
	let runs = [];
	let selectedRunId = null;
	/** The run in the run panel, as JSON. A refresh renders it only when it changes. */
	let shownRun = null;
	let refreshTimer;
	/** The number of reads of the runs. Only the newest read changes the page. */
	let reads = 0;

	/**
	 * The button is busy only while the gateway accepts the prompt. Then the
	 * form takes the next prompt, and the runs build in parallel.
	 */
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		setSubmitting(true);
		formError.textContent = "";
		try {
			const runId = await submitPrompt(form.prompt.value);
			form.reset();
			loadRuns(runId).catch(showFailure);
		} catch (error) {
			formError.textContent = messageOf(error);
		} finally {
			setSubmitting(false);
		}
	});

	refreshRuns.addEventListener("click", () => {
		loadRuns().catch(showFailure);
	});

	deleteConfirm.addEventListener("input", () => {
		deleteSubmit.disabled =
			deleteConfirm.value.trim() !== deleteForm.dataset.appName;
	});

	deleteCancel.addEventListener("click", () => deleteDialog.close());

	/**
	 * The dialog stays open until the gateway accepts the delete, and it shows
	 * the error of a delete that fails. The run panel cannot show it: the next
	 * refresh renders the run panel again.
	 */
	deleteForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const { runId } = deleteForm.dataset;
		deleteSubmit.disabled = true;
		deleteError.textContent = "";
		try {
			await deleteRun(runId);
		} catch (error) {
			deleteError.textContent = messageOf(error);
			deleteSubmit.disabled = false;
			return;
		}
		deleteDialog.close();
		// Each run of the app is deleting now. A run with no app is gone.
		loadRuns(runId).catch(showFailure);
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
		deleteError.textContent = "";
		deleteSubmit.disabled = Boolean(appName);
		deleteDialog.showModal();
		(appName ? deleteConfirm : deleteSubmit).focus();
	}

	/**
	 * Read the runs, and select the preferred run, the selected run, or the
	 * newest run. While a task owns a run, read them again after REFRESH_MS.
	 * A read that fails is tried again too, so that a short outage of the
	 * gateway does not stop the updates.
	 */
	async function loadRuns(preferredRunId) {
		window.clearTimeout(refreshTimer);
		const read = ++reads;
		try {
			const response = await fetch("/ui/apps");
			const body = response.ok ? await response.json() : null;
			// A newer read started, for example after a submit.
			if (read !== reads) return;
			if (!body) throw new Error(`Could not load run history (${response.status})`);
			runs = body.runs || [];
			const listed = (runId) => runs.some((run) => run.runId === runId);
			selectRun(
				[preferredRunId, selectedRunId].find((runId) => runId && listed(runId)) ??
					runs[0]?.runId ??
					null,
			);
		} finally {
			if (read === reads && runs.some((run) => activeStatuses.includes(run.status))) {
				refreshTimer = window.setTimeout(() => loadRuns().catch(showFailure), REFRESH_MS);
			}
		}
	}

	function selectRun(runId) {
		selectedRunId = runId;
		if (runId) localStorage.setItem("vibe-code-selected-run", runId);
		renderHistory();
		renderSelectedRun();
	}

	/** A view replaces its history, so give the focus back to the same control. */
	function renderHistory() {
		emptyHistory.hidden = runs.length > 0;
		const focusKey = document.activeElement?.dataset.focusKey;
		view.renderHistory(runs, selectedRunId, actions);
		if (focusKey) {
			document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
		}
	}

	function renderSelectedRun() {
		const run = runs.find((candidate) => candidate.runId === selectedRunId);
		if (!run) {
			runPanel.hidden = true;
			shownRun = null;
			return;
		}
		// The run panel is a live region, so change it only when the run changes.
		const json = JSON.stringify(run);
		if (json === shownRun) return;
		shownRun = json;
		renderRun(run);
	}

	function renderRun(run) {
		runPanel.hidden = false;
		runPanel.classList.toggle("failed", !healthyStatuses.includes(run.status));
		status.textContent = statusLabel(run);
		progress.textContent = run.progress || "";
		activity.hidden = !activeStatuses.includes(run.status);
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

	function setSubmitting(submitting) {
		submit.disabled = submitting;
		submit.textContent = submitting ? "Submitting…" : "Build and deploy";
	}

	/** A read of the runs failed. The next read that succeeds shows the run again. */
	function showFailure(error) {
		shownRun = null;
		runPanel.hidden = false;
		runPanel.classList.add("failed");
		status.textContent = "Request failed";
		progress.textContent = messageOf(error);
	}

	loadRuns(localStorage.getItem("vibe-code-selected-run")).catch(showFailure);
	return actions;
}

/** Start a run. The gateway gives its ID, or an error that the form shows. */
async function submitPrompt(prompt) {
	const response = await fetch("/ui/apps", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt }),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok || !body.runId) {
		throw new Error(body.detail || body.error || `Request failed (${response.status})`);
	}
	return body.runId;
}

async function deleteRun(runId) {
	const response = await fetch(`/ui/apps/${encodeURIComponent(runId)}`, {
		method: "DELETE",
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(body.error || `Delete failed (${response.status})`);
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The stage of a run that builds, or else its status. */
export function statusLabel(run) {
	return run.status === "running" ? label(run.stage || "queued") : label(run.status);
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
