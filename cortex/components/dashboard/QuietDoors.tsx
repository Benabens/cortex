import Link from "next/link";

/**
 * Les « portes » calmes : au plus deux liens texte vers les écrans qui ont vraiment quelque
 * chose en attente. Jamais une jauge, jamais un gros chiffre, jamais un badge rouge : leur
 * contenu vit sur leur page ; ici on ouvre juste la porte.
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
    <nav aria-label="En attente ailleurs" className="flex flex-wrap items-center gap-x-2.5 text-[0.84rem] text-ink-3">
      {doors.map((d, i) => (
        <span key={d.href} className="inline-flex items-center gap-x-2.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          <Link
            href={d.href}
            className="inline-flex min-h-11 items-center rounded-sm text-ink-1 underline decoration-underline decoration-1 underline-offset-[5px] transition-colors hover:decoration-underline-hover"
          >
            {d.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
