import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { chapterLine, reason, themeHref, trainHref, type NotionFacts } from "@/lib/ux/next-up";

/**
 * « À travailler maintenant » : LA réponse de l'Accueil, posée à même la page (pas de carte).
 * Le nom de la notion est le plus gros caractère de l'écran ; la phrase en dessous ne dit que
 * des faits fournis par `dashboard.next` (cf. lib/ux/next-up). Pas de durée sur le bouton :
 * l'app n'a aucune estimation par notion, et on n'en invente pas.
 */
export function PriorityHero({ title, facts }: { title: string; facts: NotionFacts }) {
  const why = reason(facts);
  const chapter = chapterLine(facts.chapter);
  return (
    <section aria-labelledby="priority-title">
      <p className="text-[0.8125rem] text-ink-3">À travailler maintenant</p>
      <h1
        id="priority-title"
        className="mt-2.5 break-words text-[2.5rem] font-semibold leading-[1.04] sm:text-[3.25rem] lg:text-[4rem] lg:leading-[1.02]"
      >
        {title}
      </h1>
      <p className="mt-3.5 max-w-[38.75rem] text-[1rem] leading-[1.55] text-ink-2 [text-wrap:pretty]">
        {why.lead}
        {why.strong && <strong className="font-semibold text-ink-1">{why.strong}</strong>}
        {why.rest}
        {chapter && <> {chapter}</>}
      </p>
      <div className="mt-[1.375rem] flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button variant="primary" href={trainHref(title)}>
          M’entraîner
          <ArrowRight className="size-4" strokeWidth={2.5} aria-hidden="true" />
        </Button>
        <Link
          href={themeHref(facts.chapter)}
          className="inline-flex min-h-11 items-center rounded-sm text-[0.875rem] text-ink-1 underline decoration-white/15 decoration-1 underline-offset-[5px] transition-colors hover:decoration-white/60"
        >
          Voir le thème
        </Link>
      </div>
    </section>
  );
}
