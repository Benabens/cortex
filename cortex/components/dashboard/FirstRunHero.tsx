import { BookPlus, ArrowRight, FolderUp, ScanSearch, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * PREMIER LANCEMENT — un compte sans AUCUN cours. On ne montre ni tableau de
 * bord vide ni message d'erreur : on explique le produit en trois temps et on
 * conduit au seul geste possible, créer sa matière. Même ton que OnboardingHero
 * (qui, lui, s'adresse à un cours existant mais pas encore préparé).
 */
export function FirstRunHero() {
  const steps = [
    {
      Icon: BookPlus,
      title: "Crée ta matière",
      desc: "Son nom, son code, son établissement. Une minute.",
    },
    {
      Icon: FolderUp,
      title: "Dépose tes annales",
      desc: "Les vrais examens passés du cours (PDF, HTML…).",
    },
    {
      Icon: ScanSearch,
      title: "Cortex apprend le format",
      desc: "Types d’exercices, barème réel, pièges récurrents.",
    },
  ];

  return (
    <section className="panel accent-field relative overflow-hidden rounded-xl" aria-labelledby="firstrun-title">
      <div className="relative p-5 sm:p-7">
        <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-violet-hi">
          <FileSearch className="size-3.5" strokeWidth={2.5} />
          Bienvenue
        </span>

        <h2 id="firstrun-title" className="mt-3 max-w-xl text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.15rem]">
          Commence par créer ta première matière.
        </h2>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          Cortex apprend le format d’un examen à partir de ses annales, puis génère des
          sujets d’entraînement qui lui ressemblent vraiment. Tout part d’un cours : le tien.
        </p>

        <ol className="mt-6 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {steps.map(({ Icon, title, desc }, i) => (
            <li key={title} className="rounded-lg border border-line bg-surface-2/40 p-3.5 edge-top">
              <span className="grid size-9 place-items-center rounded-lg border border-line bg-surface-2/60 text-violet-hi">
                <Icon className="size-[1.05rem]" strokeWidth={2.25} aria-hidden="true" />
              </span>
              <p className="mt-2.5 text-[0.85rem] font-medium text-ink-1">
                <span className="sr-only">Étape {i + 1} : </span>
                {title}
              </p>
              <p className="mt-1 text-[0.78rem] leading-snug text-ink-3">{desc}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6">
          <Button variant="primary" size="lg" href="/cours/nouveau">
            Créer ma matière
            <ArrowRight className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </section>
  );
}
