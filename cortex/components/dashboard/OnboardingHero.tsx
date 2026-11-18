import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StepList } from "./StepList";
import { useTranslations } from "use-intl/react";

/**
 * État « cours non préparé » — remplace le héro quand le back n'a rien
 * d'actionnable (analyzed=false ou données inutilisables). Enseigne le produit :
 * ce que c'est · pourquoi c'est vide · comment démarrer.
 */
export function OnboardingHero({ courseName }: { courseName: string }) {
  const t = useTranslations("dashboard");
  const steps = [
    {
      title: t("onboardingStep1Title"),
      desc: t("onboardingStep1Description"),
    },
    {
      title: t("onboardingStep2Title"),
      desc: t("onboardingStep2Description"),
    },
    {
      title: t("onboardingStep3Title"),
      desc: t("onboardingStep3Description"),
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
          {t("onboardingTitle", { courseName })}
        </h1>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          {t("onboardingDescription")}
        </p>

        <StepList steps={steps} />

        <div className="mt-6">
          <Button variant="primary" size="lg" href="/sources">
            {t("prepare")}
            <ArrowRight className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </section>
  );
}
