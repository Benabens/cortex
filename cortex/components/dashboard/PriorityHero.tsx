import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Héro « ta priorité du jour » — LE centre de gravité de l'Accueil, et presque tout l'écran.
 *
 * 100 % nourri par `dashboard.next` (label, category, examWeight, mastery). Rien n'est dérivé :
 * l'ancienne barre « Priorité — Élevée » était un score FABRIQUÉ (examWeight×4 + 24 si jamais vu)
 * rendu comme une mesure ; le « pourquoi » est désormais une phrase qui ne dit que des faits réels.
 */
export function PriorityHero({
  title,
  theme,
  weightPct,
  mastery,
}: {
  title: string;
  theme: string | null;
  weightPct: number;
  /** 0–10 côté back ; null = jamais travaillée. */
  mastery: number | null;
}) {
  return (
    <section
      className="panel accent-field relative overflow-hidden rounded-xl"
      style={{ boxShadow: "var(--shadow-card), var(--shadow-glow-violet)" }}
      aria-labelledby="priority-title"
    >
      {/* Lumière d'angle — LE seul accent lumineux de l'app, volontairement bas. */}
      <div
        className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full opacity-35 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklch, var(--color-violet) 38%, transparent), transparent 70%)",
        }}
        aria-hidden="true"
      />

      <div className="relative p-6 sm:p-8">
        <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-violet-hi">
          Ta priorité du jour
        </p>

        {/* Le plus gros caractère de l'écran : c'est LA réponse à « par où je commence ? ». */}
        <h2
          id="priority-title"
          className="mt-3 text-[1.75rem] font-semibold leading-[1.1] sm:text-[2.15rem]"
        >
          {title}
        </h2>

        {theme && <p className="mt-2 text-[0.9rem] text-ink-3">{theme}</p>}

        <p className="mt-4 max-w-[46ch] text-[0.95rem] leading-relaxed text-ink-2">
          {why(weightPct, mastery)}
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button variant="primary" size="lg" href="/entrainement">
            <Play className="size-4" strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
            M’entraîner
            <ArrowRight className="size-4" strokeWidth={2.5} aria-hidden="true" />
          </Button>
          <Link
            href="/programme"
            className="inline-flex min-h-11 items-center rounded-md px-1 text-[0.88rem] font-medium text-ink-2 underline-offset-4 transition-colors hover:text-ink-1 hover:underline"
          >
            Voir le thème
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Décimales à la française : 9.4 → « 9,4 ». */
const fr = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

/**
 * Le « pourquoi », court et honnête : uniquement des faits que le back fournit.
 * Jamais de jugement — on décrit l'écart, on ne note pas la personne.
 */
function why(weightPct: number, mastery: number | null): string {
  const effort =
    mastery === null
      ? "tu ne l’as jamais travaillée"
      : mastery < 5
        ? `tu l’as peu travaillée (${fr(mastery)}/10)`
        : `ta maîtrise est à ${fr(mastery)}/10`;

  // Poids absent/nul (analyse sans barème) → on ne l'invente pas, on n'en parle pas.
  if (weightPct <= 0) {
    return `${effort[0].toUpperCase()}${effort.slice(1)} — c’est là que ton temps rapporte le plus aujourd’hui.`;
  }
  return `Elle pèse ${fr(weightPct)} % de l’examen et ${effort} — c’est là que ton temps rapporte le plus aujourd’hui.`;
}
