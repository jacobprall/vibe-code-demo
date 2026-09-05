import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** The shadcn/ui class helper: conditional classes, with conflicts resolved. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
