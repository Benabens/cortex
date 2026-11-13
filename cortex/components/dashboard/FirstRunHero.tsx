import { ArrowRight } from "lucide-react";
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
      title: "Crée ta matière",
      desc: "Son nom, son code, son établissement. Une minute.",
    },
    {
      title: "Dépose tes annales",
      desc: "Les vrais examens passés du cours (PDF, HTML…).",
    },
    {
      title: "Cortex apprend le format",
      desc: "Types d’exercices, barème réel, pièges récurrents.",
    },
  ];

  return (
    <section className="d2-card relative overflow-hidden" aria-labelledby="firstrun-title">
      <div className="relative p-5 sm:p-7">
        <h2 id="firstrun-title" className="max-w-xl text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.15rem]">
          Commence par créer ta première matière.
        </h2>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          Cortex apprend le format d’un examen à partir de ses annales, puis génère des
          sujets d’entraînement qui lui ressemblent vraiment. Tout part d’un cours : le tien.
        </p>

        <ol className="mt-6 max-w-xl divide-y divide-line border-y border-line">
          {steps.map(({ title, desc }, i) => (
            <li key={title} className="flex gap-4 py-3.5">
              <span aria-hidden="true" className="w-4 shrink-0 font-data text-[0.85rem] tabular text-ink-3">
                {i + 1}
              </span>
              <div>
                <p className="text-[0.9rem] font-medium text-ink-1">
                  <span className="sr-only">Étape {i + 1} : </span>
                  {title}
                </p>
                <p className="mt-0.5 text-[0.82rem] leading-snug text-ink-3">{desc}</p>
              </div>
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
