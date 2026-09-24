import { activeStatuses, formatDate, label, startRunsPage, truncate } from "/runs.js";

const sites = document.querySelector("#sites");
const siteRows = document.querySelector("#site-rows");
const linkCells = [...document.querySelectorAll("#stages [data-links]")];
const linkLabels = { workflowRun: "Workflow run", sandbox: "Sandbox" };

/** The links in the stage table, so that a poll changes them only when they change. */
let shownLinks = null;

startRunsPage({ renderHistory, renderRun });

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
			name.addEventListener("click", () => select(run.runId));
			const nameCell = document.createElement("th");
			nameCell.scope = "row";
			nameCell.append(name);

			const state = document.createElement("span");
			state.className = "run-state";
			state.dataset.status = run.status;
			state.textContent = label(run.status);

			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "danger-button table-button";
			remove.textContent = "Delete";
			remove.setAttribute("aria-label", `Delete ${run.appName || "this run"}`);
			remove.hidden = activeStatuses.includes(run.status);
			remove.addEventListener("click", () => openDeleteDialog(run));

			row.append(
				nameCell,
				cell(state),
				cell(run.urls?.web ? siteLink(run.urls.web) : none()),
				cell(generationTime(run)),
				cell(formatDate(run.createdAt)),
				cell(remove),
			);
			return row;
		}),
	);
}

/**
 * Each stage links to the pages in the Render Dashboard where it runs: the
 * workflow run, which lists its subtasks, and the sandbox of the run. The
 * gateway gives null for a link that it cannot make.
 */
function renderRun(run) {
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

function siteLink(url) {
	const anchor = dashboardLink(url, new URL(url).host);
	anchor.className = "site-url";
	anchor.title = url;
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

function formatDuration(milliseconds) {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}
