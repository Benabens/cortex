import Link from "next/link";

const tools = [
  {
    href: "/recherche",
    title: "Recherche globale",
    desc: "Un Ctrl-F universel sur tous tes supports : tape « memory image » → chaque endroit où ça apparaît, surligné.",
    dot: "var(--blue)",
  },
  {
    href: "/faiblesses",
    title: "Faiblesses",
    desc: "Dépose un exo raté (note ou screenshot). Cortex retient, structure et relie tes points faibles au corpus.",
    dot: "var(--accent)",
  },
  {
    href: "/examens",
    title: "Examens générés",
    desc: "Un examen inédit au format EPFL des dernières années, ciblé sur tes faiblesses — exportable en PDF.",
    dot: "var(--green)",
  },
  {
    href: "/sources",
    title: "Sources",
    desc: "Cours, séries, midterms & finals. Choisis les examens de référence qui guident le format de génération.",
    dot: "var(--ink-3)",
  },
];

export default function Home() {
  return (
    <main className="page">
      <header className="mb-12">
        <p className="eyebrow">Computer Systems · CS202</p>
        <h1 className="h1 mt-2">Ton second cerveau de révision.</h1>
        <p className="sub mt-3 max-w-xl">
          Tout ton matériel de cours indexé en un seul endroit — cherche, repère tes lacunes,
          et génère des examens blancs qui ressemblent à ceux qui tombent vraiment.
        </p>
      </header>

      <div className="grid gap-5 sm:grid-cols-2">
        {tools.map((t) => (
          <Link key={t.href} href={t.href} className="card-link" style={{ padding: 22 }}>
            <div className="flex items-center gap-2.5">
              <span className="dot" style={{ background: t.dot }} />
              <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
                {t.title}
              </h2>
            </div>
            <p className="mt-2.5 text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              {t.desc}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
