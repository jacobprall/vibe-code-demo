import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-[var(--radius-card)] border bg-background shadow-sm transition-shadow hover:shadow-md",
				className,
			)}
			{...props}
		/>
	);
}

export function CardHeader({ className, ...props }: DivProps) {
	return <div className={cn("flex flex-col gap-1 p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: DivProps) {
	return (
		<h3
			className={cn("text-lg leading-tight font-semibold", className)}
			{...props}
		/>
	);
}

export function CardDescription({ className, ...props }: DivProps) {
	return (
		<p className={cn("text-sm text-muted-foreground", className)} {...props} />
	);
}

export function CardContent({ className, ...props }: DivProps) {
	return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: DivProps) {
	return (
		<div className={cn("flex items-center p-5 pt-0", className)} {...props} />
	);
}
