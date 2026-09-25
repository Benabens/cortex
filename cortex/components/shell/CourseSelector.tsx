"use client";

import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus } from "lucide-react";
import { useCourse } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";

const ADD = "__add__";

/**
 * Sélecteur de cours RÉEL, alimenté par /api/courses : il ne liste que les cours
 * DU COMPTE connecté, et porte l'entrée « + Ajouter un cours ». Changer de cours
 * met à jour le cours courant (persisté) → tous les écrans refetchent avec `?course=`.
 * Select natif superposé = clavier + lecteur d'écran natifs.
 */
export function CourseSelector({ className }: { className?: string }) {
  const { courseId, course, courses, ready, setCourseId } = useCourse();
  const router = useRouter();

  const initials = (course?.short ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "+";
  const title = course?.name ?? (ready ? "Aucun cours" : "Chargement…");
  const subtitle = course?.short ?? (ready ? "Crée ta première matière" : "…");

  // Pas encore de cours : un bouton franc plutôt qu'un select vide.
  if (ready && !course) {
    return (
      <button
        type="button"
        onClick={() => router.push("/cours/nouveau")}
        className={cn(
          "group flex w-full items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-2/40 p-2 pr-2.5 text-left transition-colors",
          "hover:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] hover:bg-surface-2",
          "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2",
          className
        )}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line text-violet-hi">
          <Plus className="size-4" strokeWidth={2.5} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.82rem] font-semibold text-ink-1">Ajouter un cours</span>
          <span className="block truncate text-[0.72rem] text-ink-3">Aucune matière pour l’instant</span>
        </span>
      </button>
    );
  }

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
        <span className="block truncate text-[0.82rem] font-semibold text-ink-1">{title}</span>
        <span className="block truncate text-[0.72rem] text-ink-3">{subtitle}</span>
      </span>
      <ChevronsUpDown className="size-4 shrink-0 text-ink-4 transition-colors group-hover:text-ink-2" aria-hidden="true" />

      <select
        value={courseId}
        onChange={(e) => {
          const v = e.target.value;
          if (v === ADD) router.push("/cours/nouveau");
          else setCourseId(v);
        }}
        aria-label="Changer de cours"
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
      >
        {courses.map((c) => (
          <option key={c.id} value={c.id}>
            {c.short} — {c.name}
          </option>
        ))}
        <option value={ADD}>+ Ajouter un cours…</option>
      </select>
    </div>
  );
}
