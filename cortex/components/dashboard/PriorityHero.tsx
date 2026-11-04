import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { chapterLine, reason, themeHref, trainHref, type NotionFacts } from "@/lib/ux/next-up";

/**
 * « Next up » de l'Accueil dans la carte héros D2 : la notion en titre géant, la raison en une
 * phrase, un bouton. Seule carte héros de l'app. Sur fond bleu dans les deux thèmes, d'où les
 * jetons --color-on-hero* (texte) et --color-hero-btn* (bouton blanc cassé).
 */
export function PriorityHero({ title, facts }: { title: string; facts: NotionFacts }) {
  const why = reason(facts);
  const chapter = chapterLine(facts.chapter);
  return (
    <section className="d2-hero p-6 sm:p-9 lg:p-11" aria-labelledby="priority-title">
      <p className="text-[0.8125rem] font-medium text-on-hero-2">À travailler maintenant</p>
      <h1
        id="priority-title"
        className="mt-2.5 break-words text-[2.1rem] font-semibold leading-[1.04] text-on-hero [text-wrap:balance] sm:text-[2.75rem] lg:text-[3.5rem] lg:leading-[1.02]"
      >
        {title}
      </h1>
      <p className="mt-3.5 max-w-[38.75rem] text-[1rem] leading-[1.65] text-on-hero-2 [text-wrap:pretty]">
        {why.lead}
        {why.strong && <strong className="font-semibold text-on-hero">{why.strong}</strong>}
        {why.rest}
        {chapter && <> {chapter}</>}
      </p>
      <div className="mt-[1.375rem] flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href={trainHref(title)}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-hero-btn px-5 text-[0.9rem] font-semibold text-on-hero-btn transition-colors duration-150 hover:bg-hero-btn-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:translate-y-px"
        >
          M’entraîner
          <ArrowRight className="size-4" strokeWidth={2.5} aria-hidden="true" />
        </Link>
        <Link
          href={themeHref(facts.chapter)}
          className="inline-flex min-h-11 items-center rounded-sm text-[0.875rem] text-on-hero underline decoration-white/35 decoration-1 underline-offset-[5px] transition-colors hover:decoration-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Voir le thème
        </Link>
      </div>
    </section>
  );
}
