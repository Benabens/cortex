"use client";

import { useCourse } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";

/** En-tête de page partagé — contexte de cours RÉEL, cohérent sur les 7 écrans. */
export function PageHeader({
  title,
  description,
  context = true,
  children,
  className,
}: {
  title: string;
  description?: string;
  context?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const { course } = useCourse();
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        {context && course && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem] text-ink-3">
            <span>{course.short}</span>
            <span className="text-ink-4">·</span>
            <span className="truncate">{course.name}</span>
          </div>
        )}
        <h1 className="mt-2 text-[1.9rem] font-semibold leading-tight sm:text-[2.15rem]">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">{description}</p>
        )}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{children}</div>}
    </div>
  );
}
