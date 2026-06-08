import Link from "next/link";

const tools = [
  {
    href: "/recherche",
    title: "Recherche globale",
    desc: "Ctrl-F universel sur tous tes sites : tape « memory image » → tous les endroits où ça apparaît.",
    accent: "var(--color-accent-soft)",
    ready: true,
  },
  {
    href: "/faiblesses",
    title: "Faiblesses",
    desc: "Dépose un exo raté (note + screenshot). Cortex retient et structure tes points faibles.",
    accent: "var(--color-accent)",
    ready: false,
  },
  {
    href: "/examens",
    title: "Examens générés",
    desc: "Un examen inédit au format de la prof, ciblé sur tes faiblesses + les sujets à revoir.",
    accent: "var(--color-accent-tree)",
    ready: false,
  },
  {
    href: "/sources",
    title: "Sources",
    desc: "Cours (PDF), séries, midterms, finals — avec poids de récence. Réindexation.",
    accent: "var(--color-text-secondary)",
    ready: false,
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <header className="mb-12">
        <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "var(--color-text-primary)" }}>
          Cortex
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Second cerveau · Computer Systems (CS202)
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {tools.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group block rounded-lg border p-5 transition-colors"
            style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}
          >
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: t.accent }} />
              <h2 className="text-base font-medium" style={{ color: "var(--color-text-primary)" }}>
                {t.title}
              </h2>
              {!t.ready && (
                <span className="ml-auto text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                  bientôt
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              {t.desc}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
