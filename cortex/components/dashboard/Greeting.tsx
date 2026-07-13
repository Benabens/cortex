import type { DashCourse } from "@/lib/ux/types";

function greetingNow(): string {
  const h = new Date().getHours();
  return h < 5 ? "Bonne nuit" : h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
}

/** En-tête contextuel — cours réel, salutation par heure, phrase honnête sur la couverture. */
export function Greeting({
  course,
  coveragePct,
  analyzed,
}: {
  course: DashCourse;
  coveragePct: number;
  analyzed: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem] text-ink-3">
        <span>{course.examCode}</span>
        <span className="text-ink-4">·</span>
        <span>{course.name}</span>
      </div>
      <h1 className="mt-2 text-[1.9rem] font-semibold leading-tight sm:text-[2.15rem]">
        {greetingNow()}.
      </h1>
      <p className="mt-2 max-w-xl text-[0.95rem] text-ink-2">
        {!analyzed ? (
          <>Prépare ce cours pour que Cortex sache quoi te faire réviser.</>
        ) : coveragePct > 0 ? (
          <>
            Tu couvres{" "}
            <span className="font-data font-semibold text-ink-1">{coveragePct} %</span> du
            programme. Ta priorité du jour t’attend juste en dessous.
          </>
        ) : (
          <>Tout le programme reste à couvrir — ta priorité du jour t’attend juste en dessous.</>
        )}
      </p>
    </div>
  );
}
