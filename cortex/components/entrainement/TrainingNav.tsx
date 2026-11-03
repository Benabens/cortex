import Link from "next/link";

const tabs = [
  { href: "/seance", label: "Séance" },
  { href: "/examens", label: "Examen blanc" },
  { href: "/entrainement", label: "Exo sur mesure" },
];

export function TrainingNav({ current }: { current: string }) {
  return (
    <nav aria-label="Modes d’entraînement" className="flex flex-wrap gap-1 self-start rounded-2xl border border-line bg-surface-1 p-1">
      {tabs.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={current === href ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium transition-colors ${current === href ? "bg-violet/20 text-violet-hi" : "text-ink-2 hover:bg-surface-2"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
