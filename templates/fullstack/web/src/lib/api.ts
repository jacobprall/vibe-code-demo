/**
 * Where the API lives.
 *
 * Render wires VITE_API_HOST with `fromService`, and that property is a bare
 * hostname — "vibe-demo-shop-api.onrender.com", not a URL — so the scheme has
 * to be added here. Vite inlines this at build time, which is why it is a
 * build-time variable on the static site rather than something fetched later.
 *
 * The fallback matters: the sandbox builds this without VITE_API_HOST set, and
 * without a default the bundle would contain "https://undefined" and still
 * build clean.
 */
const host = import.meta.env.VITE_API_HOST;

export const API_BASE = host ? `https://${host}` : "http://127.0.0.1:3000";

export interface Item {
	id: number;
	slug: string;
	name: string;
	description: string;
	price_cents: number;
	image_path: string | null;
}

export async function fetchItems(): Promise<Item[]> {
	const response = await fetch(`${API_BASE}/api/items`);
	if (!response.ok) throw new Error(`API responded ${response.status}`);
	const body = (await response.json()) as { items: Item[] };
	return body.items;
}

export function formatPrice(cents: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(cents / 100);
}
