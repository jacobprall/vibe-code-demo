import { activeStatuses, formatDate, startRunsPage, statusLabel, truncate } from "/runs.js";

const sites = document.querySelector("#sites");
const siteRows = document.querySelector("#site-rows");
const linkCells = [...document.querySelectorAll("#stages [data-links]")];
const linkLabels = { workflowRun: "Workflow run", sandbox: "Sandbox" };
/** The time cell of each stage, by the name of the stage. */
const timeCells = new Map(
	[...document.querySelectorAll("#stages tr[data-stage]")].map((row) => [
		row.dataset.stage,
		row.querySelector(".stage-time"),
	]),
);

/** The links in the stage table, so that a poll changes them only when they change. */
let shownLinks = null;
/** The time of each stage of the shown run, from the last poll. */
let stageTimes = new Map();

startRunsPage({ renderHistory, renderRun });
// Four times each second, so that the timer shows each second. A timer that
// runs once each second can skip a second when it runs late.
setInterval(renderTimes, 250);

function renderHistory(runs, selectedRunId, { select, openDeleteDialog }) {
	sites.hidden = runs.length === 0;
	siteRows.replaceChildren(
		...runs.map((run) => {
			const selected = run.runId === selectedRunId;
			const row = document.createElement("tr");
			row.className = selected ? "selected" : "";
			// A click anywhere on the row selects it, except on its link or its button.
			row.addEventListener("click", (event) => {
				if (!event.target.closest("a, button")) select(run.runId);
			});

			const name = document.createElement("button");
			name.type = "button";
			name.className = "site-name";
			name.textContent = run.appName || truncate(run.prompt, 34);
			name.setAttribute("aria-pressed", String(selected));
			name.dataset.focusKey = `${run.runId}:name`;
			name.addEventListener("click", () => select(run.runId));
			const nameCell = document.createElement("th");
			nameCell.scope = "row";
			nameCell.append(name);

			const state = document.createElement("span");
			state.className = "run-state";
			state.dataset.status = run.status;
			state.textContent = statusLabel(run);

			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "danger-button table-button";
			remove.textContent = "Delete";
			remove.setAttribute("aria-label", `Delete ${run.appName || "this run"}`);
			remove.hidden = activeStatuses.includes(run.status);
			remove.dataset.focusKey = `${run.runId}:delete`;
			remove.addEventListener("click", () => openDeleteDialog(run));

			row.append(
				nameCell,
				cell(state),
				cell(run.urls?.web ? siteLink(run.urls.web, run.runId) : none()),
				cell(generationTime(run)),
				cell(formatDate(run.createdAt)),
				cell(remove),
			);
			return row;
		}),
	);
}

function renderRun(run) {
	stageTimes = timesOfStages(run.stageHistory ?? []);
	renderTimes();
	renderLinks(run);
}

/**
 * How long the run was in each stage. A stage that the run went into more
 * than once adds up its times. `runningSince` is when the stage that runs now
 * started, or null for a stage that stopped.
 */
function timesOfStages(history) {
	const times = new Map();
	for (const { stage, startedAt, finishedAt } of history) {
		const time = times.get(stage) ?? { elapsed: 0, runningSince: null };
		if (finishedAt) time.elapsed += Date.parse(finishedAt) - Date.parse(startedAt);
		else time.runningSince = Date.parse(startedAt);
		times.set(stage, time);
	}
	return times;
}

/**
 * A poll gives the times of the stages. Between polls, the timer adds the
 * time since the stage that runs now started. A stage that did not start has
 * no time.
 */
function renderTimes() {
	const now = Date.now();
	for (const [stage, timeCell] of timeCells) {
		const time = stageTimes.get(stage);
		const running = time && time.runningSince !== null ? now - time.runningSince : 0;
		const text = time ? formatDuration(time.elapsed + running) : "";
		// The timer runs four times each second, so write only a time that changed.
		if (timeCell.textContent !== text) timeCell.textContent = text;
	}
}

/**
 * Each stage links to the pages in the Render Dashboard where it runs: the
 * workflow run, which lists its subtasks, and the sandbox of the run. The
 * gateway gives null for a link that it cannot make.
 */
function renderLinks(run) {
	const links = JSON.stringify(run.links ?? {});
	if (links === shownLinks) return;
	shownLinks = links;
	for (const linkCell of linkCells) {
		const anchors = linkCell.dataset.links
			.split(" ")
			.filter((name) => run.links?.[name])
			.map((name) => dashboardLink(run.links[name], linkLabels[name]));
		linkCell.replaceChildren(...(anchors.length > 0 ? anchors : [none()]));
	}
}

function cell(content) {
	const td = document.createElement("td");
	td.append(content);
	return td;
}

function siteLink(url, runId) {
	const anchor = dashboardLink(url, new URL(url).host);
	anchor.className = "site-url";
	anchor.title = url;
	anchor.dataset.focusKey = `${runId}:url`;
	return anchor;
}

function dashboardLink(url, text) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.target = "_blank";
	anchor.rel = "noreferrer";
	anchor.textContent = text;
	return anchor;
}

function none() {
	const span = document.createElement("span");
	span.className = "none";
	span.textContent = "—";
	return span;
}

/** How long the run took to build and deploy, or how long it has run so far. */
function generationTime(run) {
	const end = run.finishedAt
		? Date.parse(run.finishedAt)
		: run.status === "running"
			? Date.now()
			: null;
	return end === null ? "—" : formatDuration(end - Date.parse(run.createdAt));
}

/** Always with the seconds, so that the timer of a stage shows each second. */
function formatDuration(milliseconds) {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m ${seconds % 60}s`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}
