import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "use-intl/react";
import styles from "@/app/secondary.module.css";
import { BillingPanel } from "./BillingPanel";
import { UsagePanel } from "./UsagePanel";
import { WithdrawalForm } from "./WithdrawalForm";
import { DeleteAccount } from "./DeleteAccount";
import { ExportData } from "./ExportData";
import { ConnectedApps } from "./ConnectedApps";
import { AppearanceSetting } from "./AppearanceSetting";
import { LocaleSetting } from "./LocaleSetting";

export function AccountContent({ email, enabled, connectedAppsEnabled }: {
  email: string | null;
  enabled: boolean;
  connectedAppsEnabled: boolean;
}) {
  const t = useTranslations("account");
  return (
    <div className={styles.page}>
      <div>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{t("title")}</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">{t("description")}</p>
      </div>

      {email && (
        <div className="d2-card p-5 sm:p-6">
          <div className="text-sm text-ink-3">{t("signedInAs")}</div>
          <div className="mt-1 break-all text-lg font-medium text-ink-1">{email}</div>
        </div>
      )}

      {connectedAppsEnabled && (
        // a.d2-card impose display:block (survol des cartes-liens) : la mise en ligne passe par un conteneur.
        <Link href="/compte/assistants" className="d2-card p-5 sm:p-6">
          <span className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-lg font-semibold text-ink-1">{t("connectAssistant")}</span>
              <span className="mt-0.5 block text-[0.9rem] text-ink-2">{t("connectAssistantHint")}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
          </span>
        </Link>
      )}

      <LocaleSetting persist={enabled} />
      <AppearanceSetting />

      <BillingPanel />
      <UsagePanel />
      <WithdrawalForm />

      {connectedAppsEnabled && <ConnectedApps />}

      {enabled ? (
        <>
          <ExportData />
          <DeleteAccount />
        </>
      ) : (
        <p className="text-[0.9rem] text-ink-3">
          {t("managementDisabled")}
        </p>
      )}
    </div>
  );
}
