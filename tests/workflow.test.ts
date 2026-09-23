/**
 * A browser uses the env vars of a static site, and a static site is not on
 * Render's private network. Verification must find a private-network value
 * before the push. After the push, the Blueprint creates every resource.
 */
import { describe, expect, it } from "vitest";
import type { Service } from "../app/contracts.js";
import { checkStaticSiteEnvVars } from "../app/workflow.js";

const PRIVATE_NETWORK_PROPERTIES = ["host", "port", "hostport"];

const storefront: Service = {
	name: "storefront",
	kind: "static_site",
	rootDir: "web",
	runtime: "static",
	buildCommand: "npm ci && npm run build",
	staticPublishPath: "dist",
};

const api: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm ci && npm run build",
	startCommand: "npm start",
};

describe("checkStaticSiteEnvVars", () => {
	it.each(PRIVATE_NETWORK_PROPERTIES)(
		"rejects fromService property %s on a static site",
		(property) => {
			const failures = checkStaticSiteEnvVars({
				...storefront,
				envVars: [
					{ key: "VITE_API_HOST", fromService: { name: "api", property } },
				],
			});

			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatch(/^storefront: envVar VITE_API_HOST /);
			expect(failures[0]).toContain(
				"A browser cannot connect to a private-network name.",
			);
			expect(failures[0]).toContain(
				`Replace property ${property} with envVarKey RENDER_EXTERNAL_HOSTNAME`,
			);
		},
	);

	it("accepts the public hostname of the API on a static site", () => {
		expect(
			checkStaticSiteEnvVars({
				...storefront,
				envVars: [
					{
						key: "VITE_API_HOST",
						fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
					},
				],
			}),
		).toEqual([]);
	});

	// Services connect to each other on the private network.
	it.each(PRIVATE_NETWORK_PROPERTIES)(
		"accepts fromService property %s on a web service",
		(property) => {
			expect(
				checkStaticSiteEnvVars({
					...api,
					envVars: [
						{ key: "SEARCH_HOST", fromService: { name: "search", property } },
					],
				}),
			).toEqual([]);
		},
	);
});
