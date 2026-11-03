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
        <p className="mb-2 text-sm font-medium text-violet-hi">Ton espace personnel</p>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Mon compte</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">Ton abonnement, tes crédits et tes données.</p>
      </div>

      {email && (
        <div className="d2-hero p-5 sm:p-6">
          <div className="text-sm text-blue-100">Connecté en tant que</div>
          <div className="mt-1 break-all text-lg font-medium text-ink-1">{email}</div>
        </div>
      )}

      <nav aria-label="Rubriques du compte" className="flex flex-wrap gap-2">
        <a href="#account-billing" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface-1 px-4 text-sm text-ink-2 hover:text-violet-hi">Abonnement & crédits</a>
        {connectedAppsEnabled && <a href="#account-apps" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface-1 px-4 text-sm text-ink-2 hover:text-violet-hi">Applications connectées</a>}
        {enabled && <a href="#account-data" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface-1 px-4 text-sm text-ink-2 hover:text-violet-hi">Mes données</a>}
      </nav>

      <section className="scroll-mt-24 border-t border-line pt-7" aria-labelledby="account-billing">
        <header className="mb-5"><h2 id="account-billing" className={styles.sectionTitle}>Ton accès à Cortex</h2><p>Retrouve ton solde, tes offres et l’historique de tes crédits.</p></header>
        <div className={styles.stack}><BillingPanel /><WithdrawalForm /></div>
      </section>

      {connectedAppsEnabled && <section className={`${styles.accountSection} scroll-mt-24`} aria-labelledby="account-apps"><header><h2 id="account-apps" className={styles.sectionTitle}>Applications</h2><p>Les services auxquels tu as donné accès à Cortex.</p></header><ConnectedApps /></section>}

      {enabled ? (
        <section className={`${styles.accountSection} scroll-mt-24`} aria-labelledby="account-data">
          <header><h2 id="account-data" className={styles.sectionTitle}>Tes données</h2><p>Garde une copie de ton travail ou gère la suppression de ton compte.</p></header>
          <div className={styles.stack}><ExportData /><DeleteAccount /></div>
        </section>
      ) : (
        <p className="text-[0.9rem] text-ink-3">
          La gestion du compte est disponible une fois l’authentification activée
          (mode local mono-utilisateur : aucun compte à gérer).
        </p>
      )}
    </div>
  );
}
