import { auth, authEnabled } from "@/lib/auth";
import { BillingPanel } from "./BillingPanel";
import { DeleteAccount } from "./DeleteAccount";

export const dynamic = "force-dynamic";

/**
 * Mon compte — infos du compte + zone de danger (suppression). Server component :
 * lit la session pour afficher l'e-mail. La suppression n'a de sens qu'avec
 * l'authentification activée (sinon : mono-utilisateur local, aucun compte).
 */
export default async function ComptePage() {
  const enabled = authEnabled();
  const session = enabled ? await auth() : null;
  const email = session?.user?.email ?? null;

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="text-[1.9rem] font-semibold leading-tight sm:text-[2.15rem]">Mon compte</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] text-ink-2">Ton abonnement, tes crédits et tes données.</p>
      </div>

      {email && (
        <div className="rounded-lg border border-line bg-surface-2/40 p-5">
          <div className="text-[0.8rem] text-ink-3">Connecté en tant que</div>
          <div className="mt-1 text-[0.95rem] font-medium text-ink-1">{email}</div>
        </div>
      )}

      <BillingPanel />

      {enabled ? (
        <DeleteAccount />
      ) : (
        <p className="text-[0.9rem] text-ink-3">
          La gestion du compte est disponible une fois l’authentification activée
          (mode local mono-utilisateur : aucun compte à gérer).
        </p>
      )}
    </div>
  );
}
