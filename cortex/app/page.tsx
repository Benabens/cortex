import Link from "next/link";

const tools = [
  {
    href: "/recherche",
    icon: "🔍",
    title: "Recherche globale",
    desc: "Un Ctrl-F universel sur tous tes supports : tape « memory image » → chaque endroit où ça apparaît, surligné.",
    dot: "var(--blue)",
  },
  {
    href: "/faiblesses",
    icon: "🎯",
    title: "Faiblesses",
    desc: "Dépose un exo raté, ou colle une discussion entière. Cortex en extrait tes lacunes, les classe par thème et les relie au corpus.",
    dot: "var(--accent)",
  },
  {
    href: "/examens",
    icon: "📄",
    title: "Examens générés",
    desc: "Un examen inédit au format EPFL des dernières années, ciblé sur tes faiblesses, vérifié exo par exo — exportable en PDF.",
    dot: "var(--green)",
  },
  {
    href: "/entrainement",
    icon: "✦",
    title: "Entraînement",
    desc: "Un exo ciblé (ou à partir d'une image), des indices progressifs, et la correction de tes réponses — texte ou photo.",
    dot: "var(--blue)",
  },
  {
    href: "/sources",
    icon: "📚",
    title: "Sources",
    desc: "Cours, séries, midterms & finals. Importe un dossier entier d'un cours, choisis les examens de référence du format.",
    dot: "var(--ink-3)",
  },
];

export default function Home() {
  return (
    <main className="page">
      <header className="mb-12">
        <p className="eyebrow">Ton second cerveau de révision</p>
        <h1 className="h1 mt-2" style={{ fontSize: 40, maxWidth: 640 }}>
          Révise ce qui tombe vraiment.
        </h1>
        <p className="sub mt-4 max-w-xl" style={{ fontSize: 16, lineHeight: 1.5 }}>
          Tout ton matériel de cours indexé en un seul endroit — multi-cours. Cherche, repère tes lacunes,
          et génère des examens blancs <strong style={{ color: "var(--ink)" }}>indiscernables des vrais</strong>,
          ciblés sur ce que tu ne maîtrises pas.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link href="/examens" className="btn btn-primary">✦ Générer un examen</Link>
          <Link href="/faiblesses" className="btn btn-ghost">Capturer une faiblesse</Link>
          <span className="text-[12px] ml-1" style={{ color: "var(--ink-3)" }}>
            Cours sélectionnable en haut à droite
          </span>
        </div>
      </header>

      <div className="grid gap-5 sm:grid-cols-2">
        {tools.map((t) => (
          <Link key={t.href} href={t.href} className="card-link" style={{ padding: 22 }}>
            <div className="flex items-center gap-3">
              <span
                className="flex items-center justify-center"
                style={{ width: 38, height: 38, borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--line)", fontSize: 18 }}
              >
                {t.icon}
              </span>
              <div className="flex items-center gap-2">
                <span className="dot" style={{ background: t.dot }} />
                <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
                  {t.title}
                </h2>
              </div>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              {t.desc}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
