import Link from "next/link";
import { examLine } from "@/lib/ux/next-up";

/**
 * En-tête de l'Accueil : une ligne, le code du cours puis ce qu'on sait du final.
 * Date inconnue ou dépassée → la ligne devient le lien pour la saisir (Mes cours, champ ouvert).
 */
export function CourseLine({
  courseId,
  code,
  countdown,
}: {
  courseId: string;
  code: string;
  countdown: { date: string; days: number } | null;
}) {
  const exam = examLine(countdown);
  return (
    <p className="flex flex-wrap items-center gap-x-[1ch] font-mono text-[0.78rem] font-medium leading-[1.4] tracking-[0.01em] text-ink-3">
      {code && (
        <>
          <span>{code}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>{exam.text}</span>
      {exam.state !== "upcoming" && (
        <Link
          href={`/cours?date=${encodeURIComponent(courseId)}`}
          className="-my-3 inline-flex min-h-11 items-center rounded-sm text-ink-1 underline decoration-white/25 decoration-1 underline-offset-4 transition-colors hover:decoration-white/60"
        >
          {exam.action}
        </Link>
      )}
    </p>
  );
}
