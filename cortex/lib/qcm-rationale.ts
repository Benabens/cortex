/**
 * JUSTIFICATION STRUCTURÉE D'UN QCM — examen QCM #15 (16/11/2026, job 30) : malgré trois rondes de
 * contrôles lexicaux (#90, #97, #108), trois explications sur vingt réfutaient encore des options
 * ABSENTES (deux critères qu'aucune option ne nommait, à côté des vrais distracteurs ; quatre
 * réfutations pour trois distracteurs ; la variante d'un distracteur remplacé depuis). L'explication,
 * un paragraphe libre écrit avant le remplacement ou le mélange des distracteurs, était contrôlée
 * après coup, tournure par tournure.
 *
 * Ici le modèle ne rédige plus de paragraphe : il rend pourquoi la clé est juste et, pour CHAQUE
 * option fausse, pourquoi elle l'est. Ces raisons sont rangées comme `misconceptions`, une case
 * par option : le mélange les réindexe avec les options, un distracteur remplacé ne perd que sa
 * case (le même appel la réécrit), et l'explication affichée est ASSEMBLÉE par le code à partir
 * des textes réels des options. Une raison ne peut donc porter que sur une option qui existe, et
 * il y en a au plus une par distracteur, par construction.
 *
 * QCM_STRUCTURED_EXPLANATIONS=0 : retour au paragraphe libre (et aux contrôles lexicaux).
 * Les examens déjà en base gardent leur explication texte ; la colonne `rationale_json` est additive.
 */

/** Justification d'un QCM : la clé, et une raison par option (`""` pour une bonne réponse ou une case à écrire). */
export type QcmRationale = { key: string; wrong: string[]; lang?: string };

/** Forme enregistrée (`qcm_items.rationale_json`) et rendue par le modèle : indexée sur les options finales. */
export type StoredRationale = { v: 1; lang: string; key: string; distractors: { option_index: number; why_wrong: string }[] };

/** Justifications structurées actives (QCM_STRUCTURED_EXPLANATIONS=0 : paragraphe libre, comme avant). */
export function structuredExplanationsEnabled(): boolean {
  return process.env.QCM_STRUCTURED_EXPLANATIONS !== "0";
}

/** Champ `justification` du schéma de conception (sortie structurée stricte possible). */
export const JUSTIFICATION_SCHEMA = {
  type: "object",
  description: "Justification STRUCTURÉE, à la place d'un paragraphe : la clé, puis UNE entrée par option fausse de TON tableau options, ni plus ni moins.",
  properties: {
    key: { type: "string", description: "Pourquoi la/les bonne(s) réponse(s) est/sont juste(s), avec le fait du cours qui l'établit. Ne parle d'AUCUNE autre option." },
    distractors: {
      type: "array",
      description: "Exactement une entrée par option fausse : son indice 0-based dans options, et pourquoi CETTE option est fausse selon le cours.",
      items: {
        type: "object",
        properties: {
          option_index: { type: "integer", description: "Indice 0-based de l'option fausse dans options." },
          why_wrong: { type: "string", description: "Pourquoi cette option est fausse : le détail du cours qu'elle contredit. Ne cite ni une autre option, ni une lettre, ni un rang." },
        },
        required: ["option_index", "why_wrong"],
        additionalProperties: false,
      },
    },
  },
  required: ["key", "distractors"],
  additionalProperties: false,
} as const;

const text = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** Les options fausses (indices) d'un QCM. */
export function distractorIndices(optionCount: number, correct: number[]): number[] {
  return Array.from({ length: optionCount }, (_, i) => i).filter((i) => !correct.includes(i));
}

/**
 * La justification rendue par le modèle, rangée par option. Une entrée sur une option absente,
 * sur une bonne réponse, vide ou en double (la première compte) est ignorée : elle ne peut jamais
 * devenir une réfutation affichée. null sans justification de la clé.
 */
export function rationaleFromModel(raw: unknown, optionCount: number, correct: number[], lang?: string): QcmRationale | null {
  const j = raw as { key?: unknown; distractors?: unknown } | null;
  const key = text(j?.key);
  if (!j || !key) return null;
  const wrong = Array.from({ length: optionCount }, () => "");
  for (const d of Array.isArray(j.distractors) ? j.distractors : []) {
    const i = (d as { option_index?: unknown })?.option_index;
    const why = text((d as { why_wrong?: unknown })?.why_wrong);
    if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= optionCount || correct.includes(i as number) || !why || wrong[i as number]) continue;
    wrong[i as number] = why;
  }
  return { key, wrong, ...(lang ? { lang } : {}) };
}

/**
 * CONTRÔLE DÉTERMINISTE : une entrée par distracteur réel, chaque entrée sur une option qui existe,
 * aucune orpheline. `missing` : distracteurs sans raison ; `orphan` : raisons hors des options ou
 * sur une bonne réponse (impossibles par construction, vérifiées quand même).
 */
export function rationaleCheck(r: QcmRationale | null | undefined, optionCount: number, correct: number[]): { ok: boolean; key: boolean; missing: number[]; orphan: number[] } {
  if (!r) return { ok: false, key: false, missing: distractorIndices(optionCount, correct), orphan: [] };
  const missing = distractorIndices(optionCount, correct).filter((i) => !text(r.wrong[i]));
  const orphan = r.wrong.map((w, i) => ({ w, i })).filter(({ w, i }) => !!text(w) && (i >= optionCount || correct.includes(i))).map(({ i }) => i);
  const key = !!text(r.key);
  return { ok: key && !missing.length && !orphan.length, key, missing, orphan };
}

/** Réordonne les raisons comme les options (`order[to] = from`) : le mélange ne fait que réindexer. */
export function permuteRationale(r: QcmRationale, order: number[]): QcmRationale {
  return { ...r, wrong: order.map((from) => r.wrong[from] ?? "") };
}

/** Raisons des options `indices` effacées (option remplacée, raison invalide) : à réécrire, jamais héritées. */
export function invalidateRationale(r: QcmRationale, indices: number[]): QcmRationale {
  return { ...r, wrong: r.wrong.map((w, i) => (indices.includes(i) ? "" : w)) };
}

/**
 * Fusionne une réponse ciblée (`{ key?, distractors }`) : seules les cases `want` sont remplies —
 * une raison rendue pour une autre option, ou pour une case déjà juste, est ignorée.
 */
export function fillRationale(r: QcmRationale, got: { key?: unknown; distractors?: unknown } | null | undefined, want: { key: boolean; options: number[] }, optionCount: number, correct: number[]): QcmRationale {
  if (!got) return r;
  const parsed = rationaleFromModel({ key: text(got.key) || "-", distractors: got.distractors }, optionCount, correct);
  const wrong = r.wrong.slice(0, optionCount);
  while (wrong.length < optionCount) wrong.push("");
  for (const i of want.options) if (parsed?.wrong[i]) wrong[i] = parsed.wrong[i];
  const key = want.key && text(got.key) ? text(got.key) : r.key;
  return { ...r, key, wrong };
}

const LETTERS = "ABCDEFGH";
const WORDS: Record<string, { right: string; rights: string; wrong: string; open: string; close: string }> = {
  fr: { right: "juste", rights: "justes", wrong: "faux", open: "« ", close: " »" },
  en: { right: "correct", rights: "correct", wrong: "wrong", open: "“", close: "”" },
  de: { right: "richtig", rights: "richtig", wrong: "falsch", open: "„", close: "“" },
  it: { right: "giusta", rights: "giuste", wrong: "sbagliata", open: "« ", close: " »" },
  es: { right: "correcta", rights: "correctas", wrong: "incorrecta", open: "« ", close: " »" },
  pt: { right: "correta", rights: "corretas", wrong: "incorreta", open: "« ", close: " »" },
  nl: { right: "juist", rights: "juist", wrong: "fout", open: "“", close: "”" },
};

/** Début d'une option, coupé sur un mot : de quoi la reconnaître sans la recopier. */
function head(option: string, max = 70): string {
  const s = option.trim().replace(/\s+/g, " ");
  if (s.length <= max) return s.replace(/[.;:,]+$/u, "");
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 30 ? cut.slice(0, sp) : cut).replace(/[.;:,]+$/u, "")}…`;
}

/**
 * L'explication affichée, assemblée par le code : la clé, puis une ligne par option fausse qui a
 * sa raison, chacune désignée par sa lettre (ordre final) et le début de son texte réel. Jamais
 * une option qui n'est pas dans `options`, jamais deux lignes pour la même.
 */
export function assembleExplanation(r: QcmRationale, options: string[], correct: number[], lang = r.lang ?? "fr"): string {
  const w = WORDS[lang] ?? WORDS.en;
  const quote = (k: number) => `${w.open}${head(options[k] ?? "")}${w.close}`;
  const keys = correct.filter((k) => k >= 0 && k < options.length).sort((a, b) => a - b);
  const sep = lang === "fr" ? " : " : ": ";
  const lines = [
    `${keys.map((k) => LETTERS[k] ?? String(k + 1)).join(", ")} (${keys.length > 1 ? w.rights : w.right}) — ${keys.map(quote).join(" ; ")}${sep}${text(r.key)}`,
    ...distractorIndices(options.length, correct).filter((i) => !!text(r.wrong[i])).map((i) => `${LETTERS[i] ?? String(i + 1)} (${w.wrong}) — ${quote(i)}${sep}${text(r.wrong[i])}`),
  ];
  return lines.join("\n");
}

/** Forme enregistrée, indexée sur les options finales. */
export function toStoredRationale(r: QcmRationale, optionCount: number, correct: number[]): StoredRationale {
  return {
    v: 1, lang: r.lang ?? "fr", key: text(r.key),
    distractors: distractorIndices(optionCount, correct).filter((i) => !!text(r.wrong[i])).map((i) => ({ option_index: i, why_wrong: text(r.wrong[i]) })),
  };
}

/** Relue depuis `rationale_json` ; null si absente ou illisible (l'explication texte fait alors foi). */
export function fromStoredRationale(json: string | null | undefined, optionCount: number, correct: number[]): QcmRationale | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as Partial<StoredRationale>;
    return rationaleFromModel(s, optionCount, correct, typeof s.lang === "string" ? s.lang : undefined);
  } catch {
    return null;
  }
}

/**
 * L'explication d'un QCM enregistré : assemblée depuis sa justification structurée et ses options
 * telles qu'elles sont en base ; à défaut (examen d'avant, colonne vide), l'explication texte.
 */
export function storedExplanation(row: { rationale_json?: string | null; options_json: string; correct_json: string }, fallback: string): string {
  try {
    const options = JSON.parse(row.options_json) as string[];
    const correct = JSON.parse(row.correct_json) as number[];
    const r = fromStoredRationale(row.rationale_json, options.length, correct);
    return r ? assembleExplanation(r, options, correct) : fallback;
  } catch {
    return fallback;
  }
}
