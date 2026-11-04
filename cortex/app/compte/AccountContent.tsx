import styles from "@/app/secondary.module.css";
import { BillingPanel } from "./BillingPanel";
import { WithdrawalForm } from "./WithdrawalForm";
import { DeleteAccount } from "./DeleteAccount";
import { ExportData } from "./ExportData";
import { ConnectedApps } from "./ConnectedApps";


export function AccountContent({ email, enabled, connectedAppsEnabled }: {
  email: string | null;
  enabled: boolean;
  connectedAppsEnabled: boolean;
}) {
  return (
    <div className={styles.page}>
      <div>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Mon compte</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">Ton abonnement, tes crédits et tes données.</p>
      </div>

      {email && (
        <div className="d2-hero p-5 sm:p-6">
          <div className="text-sm text-blue-100">Connecté en tant que</div>
          <div className="mt-1 break-all text-lg font-medium text-ink-1">{email}</div>
        </div>
      )}

      <BillingPanel />
      <WithdrawalForm />

      {connectedAppsEnabled && <ConnectedApps />}

      {enabled ? (
        <>
          <ExportData />
          <DeleteAccount />
        </>
      ) : (
        <p className="text-[0.9rem] text-ink-3">
          La gestion du compte est disponible une fois l’authentification activée
          (mode local mono-utilisateur : aucun compte à gérer).
        </p>
      )}
    </div>
  );
}
