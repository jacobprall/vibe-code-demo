/**
 * Openly licensed photographs for an app, from Wikimedia Commons.
 *
 * Commons needs no API key, and everything it returns is openly licensed,
 * which is what makes shipping the result to a customer demo defensible.
 * Photographs are decoration: the builder falls back to inline SVG and CSS
 * without them. So a subject that finds nothing, or a Commons outage, gives
 * fewer photographs, not a failed run.
 */
import { factoryConfig } from "../factory.config.js";
import type { Sandbox } from "./sandbox.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "vibe-factory/0.1 (Render demo)";
const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1_000;
/** The search results to choose from, for each subject. */
const CANDIDATES = 8;

/**
 * Minimum width of the file behind the thumbnail. Measuring the thumbnail
 * instead is useless — Commons renders every one to the requested box, so a
 * 450px original comes back the same width as a 4000px one, upscaled.
 */
const MIN_SOURCE_WIDTH = 600;

/** A photograph in the app directory. */
export interface Image {
	/** Relative to the app directory, e.g. assets/walnut-dining-chair.jpg. */
	path: string;
	subject: string;
	/** The credit line that the site must publish. */
	credit: string;
}

export interface CommonsCandidate {
	title: string;
	url: string;
	/** Dimensions of the thumbnail that will land on disk. */
	width: number;
	height: number;
	/** Dimensions of the file behind it, which is what quality depends on. */
	sourceWidth: number;
	sourceHeight: number;
	credit: string;
}

/**
 * Find one photograph for each subject, and download it into the assets
 * directory of the app. All subjects search at one time. A subject that
 * finds nothing, or whose download fails, is left out.
 */
export async function collectImages(
	sandbox: Sandbox,
	appDir: string,
	subjects: readonly string[],
): Promise<Image[]> {
	const images = await Promise.all(
		subjects.map((subject) =>
			collectOne(sandbox, appDir, subject).catch((error) => {
				console.warn(
					JSON.stringify({
						event: "image_skipped",
						subject,
						reason: error instanceof Error ? error.message : String(error),
					}),
				);
				return null;
			}),
		),
	);
	return images.filter((image) => image !== null);
}

async function collectOne(
	sandbox: Sandbox,
	appDir: string,
	subject: string,
): Promise<Image> {
	const pick = bestCandidate(await searchCommonsRelaxed(subject));
	if (!pick) throw new Error("no photograph found");

	// A slug and a known extension, so the path stays in the assets directory.
	const path = `assets/${slugify(subject)}${extensionOf(pick.url)}`;
	await sandbox.writeFile(`${appDir}/${path}`, await downloadImage(pick.url));
	return { path, subject, credit: pick.credit };
}

/**
 * Pick one candidate: a real photograph, wide rather than tall, best source
 * available.
 *
 * Sorting by thumbnail area used to win, and since every thumbnail is capped
 * to the same width, that meant "tallest" — which selected portraits, the
 * largest files, and the worst shapes for a hero image.
 */
export function bestCandidate(
	candidates: readonly CommonsCandidate[],
): CommonsCandidate | undefined {
	const realEnough = candidates.filter(
		(candidate) => candidate.sourceWidth >= MIN_SOURCE_WIDTH,
	);
	const pool = realEnough.length > 0 ? realEnough : candidates;
	const landscape = pool.filter(
		(candidate) => candidate.sourceWidth >= candidate.sourceHeight,
	);

	return [...(landscape.length > 0 ? landscape : pool)].sort(
		(a, b) => b.sourceWidth * b.sourceHeight - a.sourceWidth * a.sourceHeight,
	)[0];
}

/**
 * Fetch and check one image, or throw with a reason to log. The URL comes
 * from Commons, but it is still data from the internet: only HTTPS, only an
 * allowed host, only an image, and only up to the size limit.
 */
async function downloadImage(rawUrl: string): Promise<Buffer> {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") throw new Error("not https");
	if (!factoryConfig.assets.allowedHosts.includes(url.hostname)) {
		throw new Error(`host not allowed: ${url.hostname}`);
	}

	const response = await fetch(url, {
		headers: { "user-agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
		throw new Error("not an image");
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength > factoryConfig.assets.maxBytes) {
		throw new Error(`${bytes.byteLength} bytes exceeds the limit`);
	}
	return bytes;
}

function slugify(subject: string): string {
	return (
		subject
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "image"
	);
}

function extensionOf(url: string): string {
	const match = url.match(/\.(jpe?g|png|webp)(?:\?|$)/i);
	return match ? `.${match[1].toLowerCase()}` : ".jpg";
}

/* ── Commons ──────────────────────────────────────────────────────────── */

/**
 * Words that carry no weight in an image search but do count as terms Commons
 * requires a match for.
 */
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"at",
	"closeup",
	"for",
	"from",
	"full",
	"image",
	"in",
	"into",
	"near",
	"of",
	"on",
	"over",
	"photo",
	"photograph",
	"the",
	"to",
	"under",
	"with",
]);

/**
 * Progressively shorter forms of one subject, longest first.
 *
 * Commons ANDs every term, so a natural-language subject like "Beneteau
 * Oceanis sailboat sailing offshore" matches nothing while "Beneteau Oceanis
 * sailboat" matches plenty. The architect writes prose; this turns it into
 * something the search can answer.
 */
export function commonsQueries(subject: string): string[] {
	const words = subject.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
	const significant = words.filter((word) => !STOPWORDS.has(word));

	const ladder = [
		subject.trim(),
		significant.join(" "),
		significant.slice(0, 4).join(" "),
		significant.slice(0, 3).join(" "),
		significant.slice(0, 2).join(" "),
	];
	return [...new Set(ladder.filter((query) => query.length > 0))];
}

/**
 * Search Commons for a subject, relaxing the query until something comes back.
 * Attempts are sequential: Commons rate-limits, and the first one usually wins.
 */
async function searchCommonsRelaxed(
	subject: string,
): Promise<CommonsCandidate[]> {
	let candidates: CommonsCandidate[] = [];
	for (const query of commonsQueries(subject)) {
		candidates = await searchCommons(query);
		if (candidates.length > 0) return candidates;
	}
	return candidates;
}

async function searchCommons(query: string): Promise<CommonsCandidate[]> {
	const params = new URLSearchParams({
		action: "query",
		format: "json",
		formatversion: "2",
		generator: "search",
		gsrsearch: `filetype:bitmap ${query}`,
		gsrnamespace: "6",
		gsrlimit: String(CANDIDATES),
		prop: "imageinfo",
		iiprop: "url|size|extmetadata",
		// Width only. Passing iiurlheight as well moves the thumbnails to
		// thumb.wikimedia.org, which is not an allowed host — bestCandidate
		// keeps the tall originals out instead.
		iiurlwidth: String(factoryConfig.assets.imageWidth),
	});

	// Relaxing a query multiplies the requests a run makes, and every subject
	// searches in parallel, so back off once rather than losing the subject.
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${COMMONS_API}?${params}`, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
		if (response.ok) return parseCommons(await response.json());
		if (response.status !== 429 || attempt === RATE_LIMIT_RETRIES) {
			throw new Error(`Commons responded ${response.status}`);
		}
		await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
	}
}

function parseCommons(payload: unknown): CommonsCandidate[] {
	const pages = (payload as { query?: { pages?: unknown[] } }).query?.pages;
	if (!Array.isArray(pages)) return [];

	const candidates: CommonsCandidate[] = [];
	for (const page of pages) {
		const record = page as {
			title?: string;
			imageinfo?: {
				thumburl?: string;
				thumbwidth?: number;
				thumbheight?: number;
				width?: number;
				height?: number;
				extmetadata?: Record<string, { value?: string }>;
			}[];
		};
		const info = record.imageinfo?.[0];
		// Thumbnail only. Falling back to the original once shipped an archive
		// master into a landing page.
		if (!info?.thumburl || !record.title) continue;

		const meta = info.extmetadata ?? {};
		const artist = stripHtml(meta.Artist?.value ?? "Wikimedia Commons");
		const license = stripHtml(meta.LicenseShortName?.value ?? "see Commons");
		candidates.push({
			title: record.title,
			url: info.thumburl,
			width: info.thumbwidth ?? 0,
			height: info.thumbheight ?? 0,
			sourceWidth: info.width ?? 0,
			sourceHeight: info.height ?? 0,
			credit: `${artist} / Wikimedia Commons (${license})`,
		});
	}
	return candidates;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
