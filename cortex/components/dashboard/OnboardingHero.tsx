import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StepList } from "./StepList";

/**
 * État « cours non préparé » — remplace le héro quand le back n'a rien
 * d'actionnable (analyzed=false ou données inutilisables). Enseigne le produit :
 * ce que c'est · pourquoi c'est vide · comment démarrer.
 */
export function OnboardingHero({ courseName }: { courseName: string }) {
  const steps = [
    {
      title: "Importe les annales",
      desc: "Dépose les vrais finals du cours (PDF, HTML…).",
    },
    {
      title: "Cortex les lit",
      desc: "Il déduit les types d’exos et leur poids réel à l’examen.",
    },
    {
      title: "Révise au bon moment",
      desc: "La courbe de l’oubli replanifie chaque type pour toi.",
    },
  ];

  return (
    <section
      className="d2-card relative overflow-hidden"
      aria-labelledby="onboarding-title"
    >
      <div className="relative p-5 sm:p-7">
        {/* Titre de la page dans cet état (l'Accueil n'a pas d'autre h1). */}
        <h1 id="onboarding-title" className="max-w-xl text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.15rem]">
          Prépare {courseName} pour savoir quoi réviser.
        </h1>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          Cortex n’a pas encore analysé ce cours. Donne-lui les annales : il en déduit
          les types d’exercices, leur poids à l’examen, et te dit toujours quoi travailler ensuite.
        </p>

        <StepList steps={steps} />

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
