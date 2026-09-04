/** The knobs you change when pointing this factory at your own product. */

export type ModelTier = "small" | "medium" | "large";

export interface AiroConfig {
	/** Where the apps repository is cloned inside the sandbox. */
	repoDir: string;
	/** Directory in that repository holding one subdirectory per user. */
	appsDir: string;
	/** Branch the factory pushes to. The Blueprint tracks this branch. */
	branch: string;
	/** Prefix for every Render resource the factory asks a Blueprint to create. */
	resourcePrefix: string;
	/** Path, relative to the repository root, of the factory-owned Blueprint. */
	blueprintPath: string;
	render: {
		region: string;
		/** Free web services spin down after 15 minutes, which reads badly in a demo. */
		servicePlan: string;
		/** A workspace gets one free Postgres, so generated apps use the cheapest paid tier. */
		databasePlan: string;
		postgresMajorVersion: string;
	};
	assets: {
		/** Hosts asset__fetch will download from. Nothing else is reachable. */
		allowedHosts: string[];
		maxBytes: number;
		maxCount: number;
		/** Width Commons renders thumbnails to. Caps bytes on a landing page. */
		imageWidth: number;
	};
	/** Runs the gateway will let run at once. Sandboxes and models cost money. */
	maxConcurrentRuns: number;
	models: Record<ModelTier, string>;
}

export const airoConfig: AiroConfig = {
	// Not "/home/user/apps": the repository already has an apps/ directory, and
	// the doubled path in every command and prompt reads like a bug.
	repoDir: "/home/user/repo",
	appsDir: "apps",
	branch: "main",
	resourcePrefix: "airo",
	blueprintPath: "render.yaml",
	render: {
		region: "oregon",
		servicePlan: "starter",
		databasePlan: "0.1c-256mb",
		postgresMajorVersion: "18",
	},
	assets: {
		// Commons serves thumbnails from both hosts, mixed within one response.
		// Without thumb.wikimedia.org, whichever subjects land on it fail with
		// "host not allowed" and the run quietly ships fewer photographs.
		allowedHosts: ["upload.wikimedia.org", "thumb.wikimedia.org"],
		// A landing page photograph, not an archive master. Commons will happily
		// serve a 1400px-wide portrait at 1.8 MB.
		maxBytes: 2 * 1024 * 1024,
		maxCount: 12,
		imageWidth: 1200,
	},
	maxConcurrentRuns: 3,
	models: {
		small: "claude-haiku-4-5",
		medium: "claude-sonnet-5",
		large: "claude-opus-5",
	},
};

/** Absolute path of one generated app inside the cloned repository. */
export function appPath(user: string, appName: string): string {
	return `${airoConfig.repoDir}/${appRelativePath(user, appName)}`;
}

/** Path of one generated app relative to the repository root. */
export function appRelativePath(user: string, appName: string): string {
	return `${airoConfig.appsDir}/${user}/${appName}`;
}
