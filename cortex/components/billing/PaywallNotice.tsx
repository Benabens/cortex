import { Button } from "@/components/ui/Button";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

export function PaywallNotice({ credits }: { credits: number }) {
  const t = useTranslations("billing");
  const f = useFmt();
  return (
    <div role="status" className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm text-ink-1">
      <p className="font-semibold">{t("creditsNeeded", { count: credits, formatted: f.number(credits) })}</p>
      <p className="mt-1 text-ink-2">{t("paidEngine")}</p>
      <Button variant="primary" size="md" href="/compte#credits" className="mt-3">
        {t("buyCredits")}
      </Button>
    </div>
  );
}
