import Link from "next/link";

/**
 * Les « portes » calmes : 1–2 liens TEXTE vers les écrans qui ont vraiment quelque chose
 * en attente. Jamais une jauge, jamais un gros chiffre, jamais un badge rouge — leur contenu
 * vit sur leur page dédiée ; ici on ouvre juste la porte.
 *
 * Rien à signaler → le composant ne rend rien (pas de « 0 » à contempler).
 */
export function QuietDoors({
  weaknessCount,
  reviewsDue,
}: {
  weaknessCount: number;
  reviewsDue: number;
}) {
  const doors: { href: string; label: string }[] = [];

  if (weaknessCount > 0) {
    doors.push({
      href: "/faiblesses",
      label: `${weaknessCount} faiblesse${weaknessCount > 1 ? "s" : ""} à traiter`,
    });
  }
  if (reviewsDue > 0) {
    doors.push({
      href: "/entrainement",
      label: `${reviewsDue} révision${reviewsDue > 1 ? "s" : ""} due${reviewsDue > 1 ? "s" : ""}`,
    });
  }
  if (doors.length === 0) return null;

  return (
    <nav aria-label="En attente ailleurs" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {doors.map((d, i) => (
        <span key={d.href} className="inline-flex items-center gap-x-1">
          {i > 0 && (
            <span className="text-ink-4" aria-hidden="true">
              ·
            </span>
          )}
          <Link
            href={d.href}
            className="inline-flex min-h-11 items-center rounded-md px-1 text-[0.82rem] text-ink-3 underline-offset-4 transition-colors hover:text-ink-1 hover:underline"
          >
            {d.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
