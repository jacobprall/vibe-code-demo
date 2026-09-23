/**
 * Delete the Render resources of one generated app.
 *
 * These are the factory's only Render API calls that change a service, a
 * database, or a project, and they only delete: infrastructure still comes
 * only from a committed Blueprint.
 *
 * A Blueprint change never deletes a resource, and a sync recreates a
 * resource that its Blueprint file declares and that is missing. So the
 * workflow first commits the app out of the root Blueprint. Then
 * waitForBlueprintSyncs waits until no sync of an earlier commit, which still
 * declares the app, can run. Only after that does the workflow call
 * deleteAppResources.
 *
 * The scope is the app's own project. In that project, only a service or a
 * database that the factory named for the app is deleted. The project is
 * deleted only when nothing else is left in it.
 *
 * The Workflows logs are the record of what the factory deleted. So each
 * wait, and each resource that is deleted or kept, is one JSON line in them.
 */
import { resourceStem } from "./blueprint.js";
import type { DeleteResourcesInput } from "./contracts.js";
import { type BlueprintSync, listBlueprintSyncs, renderApi } from "./render.js";

const POLL_INTERVAL_MS = 5_000;
const PROJECT_DELETE_ATTEMPTS = 12;
/**
 * GitHub sends a push event to Render in seconds, and Render then creates the
 * sync. A push from another run just before the delete's push still declares
 * the app, so its sync gets this long to appear before the wait reads them.
 */
const PUSH_EVENT_DELAY_MS = 60_000;
/** A sync in any other state can still create a resource. */
const FINISHED_SYNC_STATES = new Set(["success", "error"]);

export interface SyncWaitOptions {
	/**
	 * When this attempt pushed the commit that took the app out of the
	 * Blueprint, or null if an earlier attempt pushed it.
	 */
	pushedAt: number | null;
	/** How long an unfinished sync of the Blueprint gets to finish. */
	timeoutMs: number;
	onProgress?: (detail: string) => void | Promise<void>;
}

export interface TeardownOptions {
	workspaceId: string;
	onProgress?: (detail: string) => void | Promise<void>;
}

interface Resource {
	id: string;
	name: string;
	/** The REST collection that deletes it. */
	collection: "services" | "postgres";
}

interface Project {
	id: string;
	name: string;
	environmentIds: string[];
}

/**
 * Wait until no sync of the Blueprint waits or runs.
 *
 * From the delete's commit on, the Blueprint file does not declare the app, so
 * only a sync of an earlier commit can bring a deleted resource back. The list
 * of resources that the Blueprint manages is no signal: a push that only
 * removes resources starts no sync, and the Blueprint keeps the resources in
 * its list.
 */
export async function waitForBlueprintSyncs(
	blueprintId: string,
	opts: SyncWaitOptions,
): Promise<void> {
	if (opts.pushedAt !== null) {
		const remaining = opts.pushedAt + PUSH_EVENT_DELAY_MS - Date.now();
		if (remaining > 0) {
			console.log(
				JSON.stringify({
					event: "push_event_wait",
					blueprintId,
					delayMs: remaining,
				}),
			);
			await opts.onProgress?.("Waiting for Render to receive the push");
			await sleep(remaining);
		}
	}

	const deadline = Date.now() + opts.timeoutMs;
	let unfinished = unfinishedSyncs(await listBlueprintSyncs(blueprintId));
	let logged = "";
	while (unfinished.length > 0) {
		const syncs = unfinished.join(", ");
		// One line for each change, not one for each read.
		if (syncs !== logged) {
			console.log(
				JSON.stringify({
					event: "blueprint_syncs_unfinished",
					blueprintId,
					syncs: unfinished,
				}),
			);
			logged = syncs;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Blueprint ${blueprintId} has a sync that did not finish in ${opts.timeoutMs / 60_000} minutes: ${syncs}. ` +
					"Wait for it to finish, then delete the app again.",
			);
		}
		await opts.onProgress?.(
			`Waiting for a sync of Blueprint ${blueprintId} to finish`,
		);
		await sleep(POLL_INTERVAL_MS);
		unfinished = unfinishedSyncs(await listBlueprintSyncs(blueprintId));
	}
	console.log(
		JSON.stringify({ event: "blueprint_syncs_finished", blueprintId }),
	);
}

/**
 * Delete the services and databases of one app, then its project. Call it
 * only after waitForBlueprintSyncs, when no sync can recreate what it deletes.
 */
export async function deleteAppResources(
	app: DeleteResourcesInput,
	opts: TeardownOptions,
): Promise<string[]> {
	const stem = resourceStem(app);
	const projects = await findProjects(stem, opts.workspaceId);
	if (projects.length === 0) {
		console.log(
			JSON.stringify({ event: "render_project_not_found", name: stem }),
		);
	}

	const deleted: string[] = [];
	for (const project of projects) {
		const foreign: string[] = [];
		for (const environmentId of project.environmentIds) {
			for (const resource of await environmentResources(
				environmentId,
				opts.workspaceId,
			)) {
				// Every name the factory gives the app starts with its stem. A
				// resource with a different name stays, and so does the project.
				if (!resource.name.startsWith(`${stem}-`)) {
					console.warn(
						JSON.stringify({ event: "render_resource_kept", ...resource }),
					);
					foreign.push(resource.name);
					continue;
				}
				await opts.onProgress?.(`Deleting ${resource.name}`);
				await deleteResource(resource);
				deleted.push(resource.name);
			}
		}
		if (foreign.length > 0) {
			throw new Error(
				`Project ${stem} also holds ${foreign.join(", ")}, which the factory did not create. ` +
					"Delete or move them in the Render Dashboard, then delete the app again.",
			);
		}
		await opts.onProgress?.(`Deleting project ${stem}`);
		await deleteProject(project);
	}
	return deleted;
}

function unfinishedSyncs(syncs: readonly BlueprintSync[]): string[] {
	return syncs
		.filter((sync) => !FINISHED_SYNC_STATES.has(sync.state))
		.map(
			(sync) =>
				`${sync.commit?.slice(0, 7) ?? "unknown commit"} (${sync.state})`,
		);
}

/** Only an exact match counts, whatever the API's name filter matches. */
async function findProjects(
	name: string,
	workspaceId: string,
): Promise<Project[]> {
	const entries = await list<{ project?: Project }>("projects", {
		name,
		ownerId: workspaceId,
	});
	return entries.flatMap(({ project }) =>
		project?.name === name ? [project] : [],
	);
}

/** The services and databases of one environment, services first. */
async function environmentResources(
	environmentId: string,
	workspaceId: string,
): Promise<Resource[]> {
	const filter = { environmentId, ownerId: workspaceId };
	const services = await list<{ service?: { id: string; name: string } }>(
		"services",
		filter,
	);
	const databases = await list<{ postgres?: { id: string; name: string } }>(
		"postgres",
		filter,
	);
	return [
		...services.flatMap(({ service }) =>
			service
				? [
						{
							id: service.id,
							name: service.name,
							collection: "services" as const,
						},
					]
				: [],
		),
		...databases.flatMap(({ postgres }) =>
			postgres
				? [
						{
							id: postgres.id,
							name: postgres.name,
							collection: "postgres" as const,
						},
					]
				: [],
		),
	];
}

/** One page. An app has far fewer resources than a page holds. */
async function list<T>(
	collection: string,
	filter: Record<string, string>,
): Promise<T[]> {
	const query = new URLSearchParams({ ...filter, limit: "100" });
	const response = await renderApi(`/${collection}?${query}`);
	if (!response.ok) {
		throw new Error(
			`Listing ${collection} failed with ${response.status}: ${await detail(response)}`,
		);
	}
	return (await response.json()) as T[];
}

async function deleteResource(resource: Resource): Promise<void> {
	const response = await renderApi(
		`/${resource.collection}/${encodeURIComponent(resource.id)}`,
		"DELETE",
	);
	// 404: an earlier attempt of the delete got to it first.
	if (response.ok || response.status === 404) {
		console.log(
			JSON.stringify({ event: "render_resource_deleted", ...resource }),
		);
		return;
	}
	throw new Error(
		`Render did not delete ${resource.name} (${response.status}): ${await detail(response)}`,
	);
}

/**
 * Render refuses to delete a project that holds a resource, with a 409. The
 * deletes before this can take a short time to take effect, so a 409 is an
 * error only after some attempts.
 */
async function deleteProject(project: Project): Promise<void> {
	for (let attempt = 1; attempt <= PROJECT_DELETE_ATTEMPTS; attempt++) {
		const response = await renderApi(
			`/projects/${encodeURIComponent(project.id)}`,
			"DELETE",
		);
		if (response.ok || response.status === 404) {
			console.log(
				JSON.stringify({
					event: "render_project_deleted",
					id: project.id,
					name: project.name,
				}),
			);
			return;
		}
		if (response.status !== 409) {
			throw new Error(
				`Render did not delete project ${project.name} (${response.status}): ${await detail(response)}`,
			);
		}
		console.log(
			JSON.stringify({
				event: "render_project_not_empty",
				id: project.id,
				name: project.name,
				attempt,
			}),
		);
		if (attempt < PROJECT_DELETE_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`Render did not delete project ${project.name}, because it still holds a resource. ` +
			"Delete what is left in it in the Render Dashboard, then delete the app again.",
	);
}

async function detail(response: Response): Promise<string> {
	return (await response.text().catch(() => "")).slice(0, 300);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
