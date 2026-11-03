import Link from "next/link";

const tabs = [
  { href: "/seance", label: "Séance" },
  { href: "/examens", label: "Examen blanc" },
  { href: "/entrainement", label: "Exo sur mesure" },
];

export function TrainingNav({ current }: { current: string }) {
  return (
    <nav aria-label="Modes d’entraînement" className="grid w-full grid-cols-3 gap-1 self-start rounded-full bg-surface-1 p-1.5 sm:w-auto sm:flex">
      {tabs.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={current === href ? "page" : undefined}
          className={`inline-flex min-h-11 items-center justify-center rounded-full px-2 text-center text-[0.78rem] sm:px-5 sm:text-sm font-medium transition-colors ${current === href ? "bg-ink-1 text-[oklch(0.17_0.02_274)] shadow-sm" : "text-ink-2 hover:bg-surface-2"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
