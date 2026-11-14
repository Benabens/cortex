import { Button } from "@/components/ui/Button";

export function PaywallNotice({ credits }: { credits: number }) {
  return (
    <div role="status" className="rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm text-ink-1">
      <p className="font-semibold">Il te faut {credits.toLocaleString("fr-FR")} crédit{credits >= 2 ? "s" : ""}</p>
      <p className="mt-1 text-ink-2">Cette action utilise le moteur payant de Cortex.</p>
      <Button variant="primary" size="md" href="/compte#credits" className="mt-3">
        Acheter des crédits
      </Button>
    </div>
  );
}
