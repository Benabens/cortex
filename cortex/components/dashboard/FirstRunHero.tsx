import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StepList } from "./StepList";
import { useTranslations } from "use-intl/react";

/**
 * PREMIER LANCEMENT — un compte sans AUCUN cours. On ne montre ni tableau de
 * bord vide ni message d'erreur : on explique le produit en trois temps et on
 * conduit au seul geste possible, créer sa matière. Même ton que OnboardingHero
 * (qui, lui, s'adresse à un cours existant mais pas encore préparé).
 */
export function FirstRunHero() {
  const t = useTranslations("dashboard");
  const steps = [
    {
      title: t("firstStep1Title"),
      desc: t("firstStep1Description"),
    },
    {
      title: t("firstStep2Title"),
      desc: t("firstStep2Description"),
    },
    {
      title: t("firstStep3Title"),
      desc: t("firstStep3Description"),
    },
  ];

  return (
    <section className="d2-card relative overflow-hidden" aria-labelledby="firstrun-title">
      <div className="relative p-5 sm:p-7">
        <h2 id="firstrun-title" className="max-w-xl text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.15rem]">
          {t("firstTitle")}
        </h2>
        <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-ink-2">
          {t("firstDescription")}
        </p>

        <StepList steps={steps} />

        <div className="mt-6">
          <Button variant="primary" size="lg" href="/cours/nouveau">
            {t("firstCreate")}
            <ArrowRight className="size-4" strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </section>
  );
}
