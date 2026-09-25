import type { DashCourse } from "@/lib/ux/types";

function greetingNow(): string {
  const h = new Date().getHours();
  return h < 5 ? "Bonne nuit" : h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
}

/**
 * En-tête de l'Accueil : le cours réel, une salutation heure-aware (la touche humaine),
 * et — seulement s'il existe et qu'il est à venir — un compte à rebours d'examen discret.
 *
 * Plus de phrase sur la couverture (« Tu couvres 0 % du programme ») : une métrique de
 * jugement dès la 2e ligne, et le héro juste en dessous dit déjà quoi faire.
 */
export function Greeting({
  course,
  countdown,
}: {
  course: DashCourse;
  countdown: { date: string; days: number } | null;
}) {
  const days = countdown?.days;
  // Examen passé (days < 0) → on n'affiche rien : un « dans −31 jours » n'informe personne.
  const exam =
    days == null || days < 0
      ? null
      : days === 0
        ? "Final aujourd’hui"
        : days === 1
          ? "Final demain"
          : `Final dans ${days} jours`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem] text-ink-3">
        <span>{course.examCode}</span>
        <span className="text-ink-4">·</span>
        <span>{course.name}</span>
        {exam && (
          <>
            <span className="text-ink-4">·</span>
            <span>{exam}</span>
          </>
        )}
      </div>
      {/* Une politesse, pas un titre : le plus gros caractère de l'écran doit être la notion
          à travailler (le héro), pas « Bonsoir ». Reste le h1 sémantique de la page. */}
      <h1 className="mt-1.5 text-[1.35rem] font-semibold leading-tight">{greetingNow()}.</h1>
    </div>
  );
}
