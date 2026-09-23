/**
 * Delete the Render resources of one generated app.
 *
 * These are the factory's only Render API calls that change a service, a
 * database, or a project, and they only delete: infrastructure still comes
 * only from a committed Blueprint. A
 * Blueprint sync recreates a declared resource that is missing, and it never
 * deletes a resource that leaves the file. So the workflow first commits the
 * app out of the root Blueprint, and this module deletes nothing until the
 * Blueprint stops managing the app's resources.
 *
 * The scope is the app's own project. In that project, only a service or a
 * database that the factory named for the app is deleted. The project is
 * deleted only when nothing else is left in it.
 */
import { resourceNames, resourceStem } from "./blueprint.js";
import type { AppSpec } from "./contracts.js";
import { type BlueprintDetail, getBlueprint, renderApi } from "./render.js";

const POLL_INTERVAL_MS = 5_000;
const PROJECT_DELETE_ATTEMPTS = 12;

export interface TeardownOptions {
	workspaceId: string;
	/** The Blueprint that watches the apps repository, or null if none does. */
	blueprintId: string | null;
	/** How long the Blueprint gets to stop managing the app's resources. */
	releaseTimeoutMs: number;
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

/** Delete the services and databases of one app, then its project. */
export async function deleteAppResources(
	spec: AppSpec,
	opts: TeardownOptions,
): Promise<string[]> {
	if (opts.blueprintId) {
		await waitForRelease(opts.blueprintId, declaredNames(spec), opts);
	}

	const stem = resourceStem(spec);
	const deleted: string[] = [];
	for (const project of await findProjects(stem, opts.workspaceId)) {
		const foreign: string[] = [];
		for (const environmentId of project.environmentIds) {
			for (const resource of await environmentResources(
				environmentId,
				opts.workspaceId,
			)) {
				// Every name the factory gives the app starts with its stem. A
				// resource with a different name stays, and so does the project.
				if (!resource.name.startsWith(`${stem}-`)) {
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

function declaredNames(spec: AppSpec): string[] {
	const names = resourceNames(spec);
	return [...names.services.values(), ...names.databases.values()];
}

/**
 * Wait until the Blueprint manages none of the app's resources and no sync
 * runs. A sync that started before the app left the file can still create a
 * resource of the app, and a resource deleted while the Blueprint manages it
 * comes back on the next sync.
 */
async function waitForRelease(
	blueprintId: string,
	names: readonly string[],
	opts: TeardownOptions,
): Promise<void> {
	const deadline = Date.now() + opts.releaseTimeoutMs;
	let blueprint = await getBlueprint(blueprintId);
	let held = heldBy(blueprint, names);

	while (held.length > 0 || blueprint.status === "syncing") {
		if (Date.now() >= deadline) {
			const minutes = opts.releaseTimeoutMs / 60_000;
			throw new Error(
				[
					held.length > 0
						? `Blueprint ${blueprintId} still manages ${held.join(", ")} after ${minutes} minutes.`
						: `Blueprint ${blueprintId} is still syncing after ${minutes} minutes.`,
					blueprint.autoSync
						? `Its status is "${blueprint.status}".`
						: "Auto Sync is off, so the push did not sync. Sync the Blueprint, then delete the app again.",
				].join(" "),
			);
		}
		await opts.onProgress?.(
			held.length > 0
				? `Waiting for Render to stop managing ${held.join(", ")}`
				: `Waiting for Blueprint ${blueprintId} to finish a sync`,
		);
		await sleep(POLL_INTERVAL_MS);
		blueprint = await getBlueprint(blueprintId);
		held = heldBy(blueprint, names);
	}
}

function heldBy(
	blueprint: BlueprintDetail,
	names: readonly string[],
): string[] {
	// Without the list, a managed resource looks released. Stop instead.
	if (!Array.isArray(blueprint.resources)) {
		throw new Error(`Blueprint ${blueprint.id} returned no resource list.`);
	}
	return blueprint.resources
		.map((resource) => resource.name)
		.filter((name) => names.includes(name));
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
