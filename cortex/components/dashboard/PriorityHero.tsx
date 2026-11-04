import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { chapterLine, reason, themeHref, trainHref, type NotionFacts } from "@/lib/ux/next-up";

/** Priorité existante du tableau de bord, présentée dans la carte bleue D2. */
export function PriorityHero({ title, facts }: { title: string; facts: NotionFacts }) {
  const why = reason(facts);
  const chapter = chapterLine(facts.chapter);
  return (
    <section className="d2-hero p-6 sm:p-9 lg:p-11" aria-labelledby="priority-title">
      <p className="text-[0.8125rem] font-medium text-blue-100">À travailler maintenant</p>
      <h1
        id="priority-title"
        className="mt-2.5 break-words text-[2.1rem] font-semibold leading-[1.04] sm:text-[2.75rem] lg:text-[3.5rem] lg:leading-[1.02]"
      >
        {title}
      </h1>
      <p className="mt-3.5 max-w-[38.75rem] text-[1rem] leading-[1.65] text-blue-100 [text-wrap:pretty]">
        {why.lead}
        {why.strong && <strong className="font-semibold text-ink-1">{why.strong}</strong>}
        {why.rest}
        {chapter && <> {chapter}</>}
      </p>
      <div className="mt-[1.375rem] flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button variant="secondary" className="border-white/20! bg-blue-50! text-blue-950! hover:bg-white!" href={trainHref(title)}>
          M’entraîner
          <ArrowRight className="size-4" strokeWidth={2.5} aria-hidden="true" />
        </Button>
        <Link
          href={themeHref(facts.chapter)}
          className="inline-flex min-h-11 items-center rounded-sm text-[0.875rem] text-ink-1 underline decoration-underline decoration-1 underline-offset-[5px] transition-colors hover:decoration-underline-hover"
        >
          Voir le thème
        </Link>
      </div>
    </section>
  );
}
