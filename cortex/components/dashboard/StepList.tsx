/** Étapes numérotées d'un premier pas (premier lancement, cours pas encore préparé) : une liste à filets, sans cartes. */
export function StepList({ steps }: { steps: { title: string; desc: string }[] }) {
  return (
    <ol className="mt-6 max-w-xl divide-y divide-line border-y border-line">
      {steps.map(({ title, desc }, i) => (
        <li key={title} className="flex gap-4 py-3.5">
          <span aria-hidden="true" className="w-4 shrink-0 font-data text-[0.85rem] tabular text-ink-3">
            {i + 1}
          </span>
          <div>
            <p className="text-[0.9rem] font-medium text-ink-1">
              <span className="sr-only">Étape {i + 1} : </span>
              {title}
            </p>
            <p className="mt-0.5 text-[0.82rem] leading-snug text-ink-3">{desc}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
