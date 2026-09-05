import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const button = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/90",
				outline: "border bg-background hover:bg-accent",
				ghost: "hover:bg-accent hover:text-accent-foreground",
			},
			size: {
				default: "h-10 px-4 py-2",
				sm: "h-9 px-3",
				lg: "h-11 px-6 text-base",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof button>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
	return (
		<button className={cn(button({ variant, size }), className)} {...props} />
	);
}
