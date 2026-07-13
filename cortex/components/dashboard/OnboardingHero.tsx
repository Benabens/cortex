import { FolderUp, ArrowRight, ScanSearch, CalendarClock, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * État « cours non préparé » — remplace le héro quand le back n'a rien
 * d'actionnable (analyzed=false ou données inutilisables). Enseigne le produit :
 * ce que c'est · pourquoi c'est vide · comment démarrer.
 */
export function OnboardingHero({ courseName }: { courseName: string }) {
  const steps = [
    {
      Icon: FolderUp,
      title: "Importe les annales",
      desc: "Dépose les vrais finals du cours (PDF, HTML…).",
    },
    {
      Icon: ScanSearch,
      title: "Cortex les lit",
      desc: "Il déduit les types d’exos et leur poids réel à l’examen.",
    },
    {
      Icon: CalendarClock,
      title: "Révise au bon moment",
      desc: "La courbe de l’oubli replanifie chaque type pour toi.",
    },
  ];

  return (
    <section
      className="panel accent-field relative overflow-hidden rounded-xl"

      aria-labelledby="onboarding-title"
    >
      <div className="relative p-5 sm:p-7">
        <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-violet-hi">
          <FileSearch className="size-3.5" strokeWidth={2.5} />
          Cours non préparé
        </span>

        <h2 id="onboarding-title" className="mt-3 max-w-xl text-[1.7rem] font-semibold leading-[1.12] sm:text-[2rem]">
          Prépare {courseName} pour savoir quoi réviser.
        </h2>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          Cortex n’a pas encore analysé ce cours. Donne-lui les annales : il en déduit
          les types d’exercices, leur poids à l’examen, et te dit toujours quoi travailler ensuite.
        </p>

        <ol className="mt-6 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {steps.map(({ Icon, title, desc }, i) => (
            <li
              key={title}
              className="rounded-lg border border-line bg-surface-2/40 p-3.5 edge-top"
            >
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
          <Button variant="primary" size="lg" href="/sources">
            Préparer le cours
            <ArrowRight className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </section>
  );
}
