"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/Button";

const CONFIRM_WORD = "SUPPRIMER";

/**
 * Zone de danger : suppression de compte. Confirmation forte (retaper un mot),
 * pas de suppression en un clic. Après succès : déconnexion + retour à l'accueil.
 * Copie sobre (skill ux-copy), sans dramatiser.
 */
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"idle" | "deleting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canDelete = typed.trim() === CONFIRM_WORD && state === "idle";

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setState("idle");
      // focus l'input à l'ouverture
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state !== "deleting") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, state]);

  async function confirmDelete() {
    if (!canDelete) return;
    setState("deleting");
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: CONFIRM_WORD }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "La suppression a échoué. Réessaie dans un instant.");
        setState("idle");
        return;
      }
      setState("done");
      // Déconnexion puis retour à l'accueil (le compte n'existe plus).
      await signOut({ callbackUrl: "/" });
    } catch {
      setError("Connexion impossible. Vérifie ta connexion et réessaie.");
      setState("idle");
    }
  }

  return (
    <section className="rounded-lg border border-[color-mix(in_oklch,var(--color-danger)_35%,var(--color-line))] bg-[color-mix(in_oklch,var(--color-danger)_6%,transparent)] p-5">
      <h2 className="text-[0.95rem] font-semibold text-ink-1">Supprimer mon compte</h2>
      <p className="mt-1.5 max-w-2xl text-[0.85rem] leading-relaxed text-ink-2">
        Efface définitivement votre compte et toutes vos données : cours, annales,
        examens générés, faiblesses, planning, fichiers et crédits. Cette action est
        irréversible.
      </p>
      <div className="mt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Supprimer mon compte
        </Button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && state !== "deleting") setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="del-title"
            className="w-full max-w-md rounded-xl border border-line-strong bg-surface-1 p-6 shadow-[var(--shadow-pop)]"
          >
            <h3 id="del-title" className="text-[1.05rem] font-semibold text-ink-1">
              Supprimer votre compte ?
            </h3>
            <div className="mt-3 space-y-2 text-[0.85rem] leading-relaxed text-ink-2">
              <p>Cette action est définitive. Seront effacés :</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>votre compte et vos connexions ;</li>
                <li>tous vos cours et leur contenu (annales, examens, faiblesses, planning) ;</li>
                <li>vos fichiers et vos crédits.</li>
              </ul>
              <p className="text-ink-3">
                Vos données d’usage sont anonymisées, sans lien avec vous.
                L’effacement de nos sauvegardes se termine sous 30 jours.
              </p>
            </div>

            <label htmlFor="del-confirm" className="mt-4 block text-[0.82rem] text-ink-2">
              Pour confirmer, tapez <span className="font-semibold text-ink-1">{CONFIRM_WORD}</span> :
            </label>
            <input
              id="del-confirm"
              ref={inputRef}
              type="text"
              autoComplete="off"
              value={typed}
              disabled={state === "deleting" || state === "done"}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canDelete) confirmDelete(); }}
              className="mt-1.5 w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink-1 outline-none focus:border-[color-mix(in_oklch,var(--color-danger)_55%,transparent)]"
              placeholder={CONFIRM_WORD}
            />

            {error && (
              <p role="alert" className="mt-3 text-[0.82rem]" style={{ color: "var(--color-danger)" }}>
                {error}
              </p>
            )}
            {state === "done" && (
              <p className="mt-3 text-[0.82rem] text-ink-2">Compte supprimé. Déconnexion…</p>
            )}

            <div className="mt-5 flex justify-end gap-2.5">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={state === "deleting" || state === "done"}>
                Annuler
              </Button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={!canDelete}
                className="inline-flex h-11 items-center justify-center rounded-md border px-4 text-sm font-semibold text-white transition-[background,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: "linear-gradient(180deg, var(--color-danger), color-mix(in oklch, var(--color-danger) 84%, black))",
                  borderColor: "color-mix(in oklch, var(--color-danger) 55%, transparent)",
                }}
              >
                {state === "deleting" ? "Suppression…" : "Supprimer définitivement"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
