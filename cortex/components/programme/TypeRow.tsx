import { FileText, BookOpen } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import type { UiType } from "@/lib/ux/program";

/**
 * Ligne « notion » (REFONTE ALLÉGÉE) — informative, pas un CTA d'entraînement.
 * Montre : la notion + sa méthode, combien de fois elle est TOMBÉE aux finals, les vrais points
 * (si un barème existe), et DEUX deep-links réels : le PDF du final à la bonne page + le passage
 * de cours associé. Rien d'inventé : un lien/point absent n'est simplement pas rendu.
 */
export function TypeRow({ t }: { t: UiType }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg px-3 py-3.5 transition-colors hover:bg-surface-2/40 sm:flex-row sm:items-start sm:gap-5">
      {/* identité + deep-links */}
      <div className="min-w-0 flex-1">
        <h4 className="text-[0.95rem] font-medium text-ink-1">{t.title}</h4>
        {t.desc && <p className="mt-0.5 line-clamp-2 text-[0.8rem] leading-relaxed text-ink-3">{t.desc}</p>}
        {(t.examHref || t.courseHref) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {t.examHref && (
              <DeepLink href={t.examHref} Icon={FileText}>
                {t.examYear ? `Final ${t.examYear}` : "Voir dans le final"}
                {t.examPage ? ` · p.${t.examPage}` : ""}
              </DeepLink>
            )}
            {t.courseHref && (
              <DeepLink href={t.courseHref} Icon={BookOpen}>
                Passage de cours
              </DeepLink>
            )}
          </div>
        )}
      </div>

      {/* combien de fois c'est tombé (+ points réels si dispo) */}
      <div className="flex shrink-0 items-center gap-x-3 gap-y-0.5 text-[0.8rem] text-ink-3 sm:flex-col sm:items-end sm:gap-1 sm:pt-0.5">
        {t.count > 0 ? (
          <span className="whitespace-nowrap" aria-label={`tombé ${t.count} fois aux finals`}>
            Tombé <span className="font-data font-semibold text-ink-1 tabular">{t.count}</span> fois
          </span>
        ) : (
          <span className="whitespace-nowrap text-ink-4">au programme</span>
        )}
        {t.points != null && (
          <span className="whitespace-nowrap font-data tabular text-ink-3">{t.points} pts</span>
        )}
      </div>
    </div>
  );
}

function DeepLink({
  href,
  Icon,
  children,
}: {
  href: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/50 px-2 py-1 text-[0.76rem] font-medium text-ink-2",
        "transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_40%,transparent)] hover:text-violet-hi",
        "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2"
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} aria-hidden={true} />
      {children}
    </a>
  );
}
