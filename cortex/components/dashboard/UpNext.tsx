import Link from "next/link";
import { asText } from "@/lib/ux/api";
import { rowFacts, rowFactsSpoken, trainHref } from "@/lib/ux/next-up";
import type { DashNext } from "@/lib/ux/types";

/**
 * « Ensuite » : les notions qui suivent par priorité, en liste à filets. Le nom à gauche, les
 * faits à droite (lecture, occurrences, part des questions). Chaque ligne ouvre l'entraînement
 * sur sa notion. Liste vide (une seule notion au programme) → rien n'est rendu.
 */
export function UpNext({ topics }: { topics: DashNext[] }) {
  const rows = topics
    .map((t) => ({ t, label: asText(t.label) }))
    .filter((r): r is { t: DashNext; label: string } => !!r.label);
  if (rows.length === 0) return null;

  return (
    <section className="d2-card p-5 sm:p-7" aria-labelledby="upnext-title">
      <h2 id="upnext-title" className="mb-3 text-lg font-semibold text-ink-1">
        Ensuite
      </h2>
      <ul className="divide-y divide-line">
        {rows.map(({ t, label }) => {
          const facts = {
            count: t.count,
            examWeight: t.examWeight,
            chapter: t.chapter ? { lectureNo: t.chapter.lectureNo, title: asText(t.chapter.title) } : null,
          };
          return (
          <li key={t.id}>
            <Link
              href={trainHref(label)}
              className="group -mx-3 flex flex-col gap-x-4 gap-y-1 rounded-xl px-3 py-4 transition-colors duration-150 hover:bg-accent/10 active:bg-accent/10 sm:flex-row sm:items-baseline"
            >
              <span className="min-w-0 flex-1 text-[0.97rem] text-ink-1">{label}</span>
              {/* « L11 · tombé 9 fois » se lit mal à voix haute : version en toutes lettres à côté. */}
              <span
                aria-hidden="true"
                className="shrink-0 font-mono text-[0.78rem] text-ink-3 transition-colors duration-150 group-hover:text-ink-2"
              >
                {rowFacts(facts)}
              </span>
              <span className="sr-only">, {rowFactsSpoken(facts)}</span>
            </Link>
          </li>
          );
        })}
      </ul>
    </section>
  );
}
