import Link from "next/link";

export function PaywallNotice({ credits }: { credits: number }) {
  return (
    <div role="dialog" aria-label="Crédits requis" className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm text-ink-1">
      <p className="font-semibold">Il te faut {credits.toLocaleString("fr-FR")} crédit{credits >= 2 ? "s" : ""}</p>
      <p className="mt-1 text-ink-2">Cette action utilise le moteur payant de Cortex.</p>
      <Link href="/compte#credits" className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-accent px-4 font-semibold text-white hover:opacity-90">
        Acheter
      </Link>
    </div>
  );
}
