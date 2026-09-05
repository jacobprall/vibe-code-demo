import { useEffect, useState } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { fetchItems, formatPrice, type Item } from "@/lib/api";

/**
 * The storefront. Replace the copy, the layout, and the sections with the real
 * product — this exists to prove the wiring end to end, not to be shipped as
 * written. Keep the data fetch: the list below is what the deployed app is
 * checked against.
 */
export function App() {
	const [items, setItems] = useState<Item[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetchItems()
			.then(setItems)
			.catch((cause: unknown) => setError(String(cause)));
	}, []);

	return (
		<main className="mx-auto max-w-5xl px-6 py-16">
			<header className="mb-12">
				<h1 className="text-4xl font-semibold tracking-tight">Storefront</h1>
				<p className="mt-3 max-w-prose text-muted-foreground">
					Served as a static site from Render's CDN, reading from an API and a
					Postgres database.
				</p>
			</header>

			{error && (
				<p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
					Could not reach the API: {error}
				</p>
			)}

			<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => (
					<Card key={item.id}>
						{item.image_path && (
							<img
								src={item.image_path}
								alt={item.name}
								className="aspect-4/3 w-full object-cover"
							/>
						)}
						<CardHeader>
							<CardTitle>{item.name}</CardTitle>
							<CardDescription>{item.description}</CardDescription>
						</CardHeader>
						<CardContent>
							<span className="font-medium">
								{formatPrice(item.price_cents)}
							</span>
						</CardContent>
					</Card>
				))}
			</div>
		</main>
	);
}
