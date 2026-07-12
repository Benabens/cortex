"use client";

import { ChevronsUpDown } from "lucide-react";
import { COURSES, useCourse } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";

/**
 * Sélecteur de cours RÉEL : change le cours courant (persisté) → tous les écrans
 * refetchent avec `?course=`. Select natif superposé = clavier + lecteur d'écran natifs.
 */
export function CourseSelector({ className }: { className?: string }) {
  const { courseId, course, setCourseId } = useCourse();
  const initials = course.short.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();

  return (
    <div
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-lg border border-line bg-surface-2/60 p-2 pr-2.5 text-left transition-colors",
        "hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)] hover:bg-surface-2",
        "focus-within:outline-2 focus-within:outline-violet focus-within:outline-offset-2",
        className
      )}
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-md font-data text-[0.72rem] font-semibold text-white"
        style={{
          background: "linear-gradient(150deg, var(--color-violet), var(--color-cyan))",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
        }}
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.82rem] font-semibold text-ink-1">
          {course.name}
        </span>
        <span className="block truncate text-[0.72rem] text-ink-3">{course.short}</span>
      </span>
      <ChevronsUpDown className="size-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-2" aria-hidden="true" />

      <select
        value={courseId}
        onChange={(e) => setCourseId(e.target.value)}
        aria-label="Changer de cours"
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
      >
        {COURSES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.short} — {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
