import { activeStatuses, formatDate, label, startRunsPage, truncate } from "/runs.js";

const runList = document.querySelector("#run-list");
const stages = document.querySelector("#stages");
const deleteButton = document.querySelector("#delete-run");

/** The run that the run panel shows, for its delete button. */
let shownRun = null;

const page = startRunsPage({ renderHistory, renderRun });

deleteButton.addEventListener("click", () => {
	if (shownRun) page.openDeleteDialog(shownRun);
});

/**
 * Escape closes an open stage tooltip, and the pointer and the focus stay
 * where they are (WCAG 1.4.13). The next stage that the pointer or the focus
 * goes to opens its tooltip again.
 */
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") stages.classList.add("tips-closed");
});
for (const type of ["pointerover", "focusin"]) {
	stages.addEventListener(type, () => stages.classList.remove("tips-closed"));
}

function renderHistory(runs, selectedRunId, { select }) {
	runList.replaceChildren(
		...runs.map((run) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = `run-item${run.runId === selectedRunId ? " selected" : ""}`;
			button.dataset.runId = run.runId;
			button.setAttribute("aria-pressed", String(run.runId === selectedRunId));

			const name = document.createElement("strong");
			name.textContent = run.appName || truncate(run.prompt, 34);
			// The status is its own element, so the stylesheet can color it by state.
			const state = document.createElement("span");
			state.className = "run-state";
			state.dataset.status = run.status;
			state.textContent = label(run.status);
			const meta = document.createElement("span");
			meta.className = "run-meta";
			meta.append(state, ` · ${formatDate(run.createdAt)}`);
			button.append(name, meta);
			button.addEventListener("click", () => select(run.runId));
			return button;
		}),
	);
}

function renderRun(run) {
	shownRun = run;
	deleteButton.hidden = activeStatuses.includes(run.status);
	deleteButton.textContent = run.appName ? "Delete app" : "Delete run";
}
