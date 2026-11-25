/**
 * L'ÉTAPE D'UNE GÉNÉRATION, DITE À L'ÉTUDIANT. Le moteur écrit dans `current_step` des phrases
 * de travail (« Génération de 4 QCM (architecte · moules + idées fausses)… », « QCM rejeté : clé
 * contestée… », « Lot 2 · Vérif 1/2 — « … » : ok ») : elles font le journal et restent lisibles par
 * le connecteur MCP, mais l'interface les affichait telles quelles (audit generation-ux du 24/11).
 *
 * Ici, chaque phrase est rangée dans une étape stable (lire, préparer, rédiger, vérifier,
 * remplacer, relire, mettre en page), avec un compteur quand la phrase en porte un. Le suivi
 * (`stageTracker`) garde l'étape précédente quand une phrase n'en dit rien (ligne de journal,
 * mesure « ⏱ »), et compte les questions composées terminées. Pur : aucune base, aucune horloge.
 */

export const STAGES = ["read", "format", "program", "plan", "write", "check", "refill", "review", "render"] as const;
export type Stage = (typeof STAGES)[number];

/** Ce qu'on compte : des questions composées, des exercices (examen écrit), des QCM. */
export type StageUnit = "question" | "exercise" | "qcm";

export type StageInfo = {
  key: "stage";
  stage: Stage;
  /** Unités terminées / commandées, quand la phrase (ou le suivi) les connaît. */
  done?: number;
  total?: number;
  unit?: StageUnit;
  /** Version en cours d'une question reprise (2, 3). */
  version?: number;
};

type Rule = { re: RegExp; stage: Stage | ((type: string) => Stage) };

/** Lignes qui ne disent rien de l'avancement : mesure de phase, reprise, fin (le statut le dit). */
const SILENT = /^(⏱|⚠|Worker (démarré|interrompu)|Reprise après interruption|Point de reprise|Terminé|Examen.* prêt|Mock QCM|Cours prêt|Ingestion terminée|Ingéré \(|Annulé|Index : .*✓|Format détecté : )/u;

/** Ordre significatif : la première règle qui reconnaît la phrase l'emporte. */
const RULES: Rule[] = [
  { re: /^Pré-vérifications/u, stage: "plan" },
  { re: /Rendu du PDF|Compilation (LaTeX|du PDF)|PDF non compilé|Mise en page/u, stage: "render" },
  { re: /manquant\(s\) →|lot\(s\) de comblement|régénération ciblée|→ (remplacement|nouveau complément)|: reprise sur |refaite|nouvel essai|à régénérer|réessai/u, stage: "refill" },
  { re: /^(Revue finale|Audit final|Audit des doublons|Contrôle final|Contrôles déterministes|Dernière vérification|Doublons|Explications assemblées)|→ revue finale|faute de remplaçant|sous-question \([a-z]\) retirée/u, stage: "review" },
  { re: /Vérif|vérifi|à l'aveugle|^QCM (gardé|rejeté|à régénérer)|rejetée|inutilisable|distracteur|clé contestée|hors cours|hors matière|durcissement|critique adversariale|dernière passe|validé \(piège|trop faible|écarté/u, stage: "check" },
  { re: /^Génération de \d+ QCM|^Lot QCM|^Ouverte \d|^Question ouverte|^Question composée|génération de \d+ exercice|rédaction de l'énoncé|conception du piège|^Lot \d+ · Q\d|questions construites|exercices (rédigés|construits|repris)|généré ✓|^Génération de l'examen|^Lot \d+\/\d+ ?[:—-]|étude : archétype/u, stage: "write" },
  { re: /^(Architecte|Faits testables|Composition ramenée)/u, stage: "plan" },
  { re: /^(Blueprint|Analyse du programme|Index\b)|index exo-par-exo/u, stage: "program" },
  { re: /^Format\b|Détection du format/u, stage: (type) => (type === "exam" || type === "qcm" ? "plan" : "format") },
  { re: /^(Ingestion|Import du dossier|Lecture des fichiers|Indexation|Vocabulaire|Récap|Corpus ingéré)/u, stage: "read" },
];

/** Étape d'une phrase du moteur, avec le compteur qu'elle porte ; null si elle n'en dit rien. */
export function classifyStep(type: string, step: string): Omit<StageInfo, "key"> | null {
  const s = step.trim();
  if (!s || SILENT.test(s)) return null;
  const rule = RULES.find((r) => r.re.test(s));
  if (!rule) return null;
  const stage = typeof rule.stage === "function" ? rule.stage(type) : rule.stage;
  const out: Omit<StageInfo, "key"> = { stage };
  const built = /(\d+)\s*\/\s*(\d+) QCM construits/u.exec(s) ?? /^(\d+) QCM construits \+ vérifiés pour (\d+) places/u.exec(s);
  // Examen écrit : les exercices de l'examen, pas ses lots (« Lot 2/3 » ne disait rien à l'étudiant,
  // et les lots tournent en parallèle). Compteur propre à l'étape : rédigés, puis vérifiés.
  const exercises = /(\d+)\/(\d+) exercices (rédigés|construits|repris|vérifiés)/u.exec(s);
  if (built) Object.assign(out, { stage: "write" as const, done: Number(built[1]), total: Number(built[2]), unit: "qcm" as const });
  else if (exercises) Object.assign(out, { done: Number(exercises[1]), total: Number(exercises[2]), unit: "exercise" as const });
  const version = /\(version (\d+)\)/u.exec(s);
  if (version) out.version = Number(version[1]);
  return out;
}

const COMPOSED = /^Question composée \d+\/(\d+)/u;
const COMPOSED_READY = /^(\d+)\/(\d+) questions composées prêtes/u;
const LOOP: Stage[] = ["write", "check", "refill"];

/** Un compteur de QCM vaut pour toute la boucle rédiger → vérifier → remplacer ; celui des exercices, pour son étape. */
function carries(last: StageInfo, stage: Stage): boolean {
  if (last.unit === "exercise") return last.stage === stage;
  return last.stage === stage || (LOOP.includes(last.stage) && LOOP.includes(stage));
}

/**
 * Suivi d'un job : à chaque phrase, l'étape à afficher (la précédente si la phrase n'en dit rien).
 * Questions composées : elles se construisent en parallèle, « Question composée 3/7 » est la
 * dernière commencée, pas la 3e de 7 ; le compte vient de « 4/7 questions composées prêtes »
 * (lib/blocks), et vaut jusqu'à la fin de l'examen.
 */
export function stageTracker(type: string): (step: string) => StageInfo | null {
  let last: StageInfo | null = null;
  let composed: { done: number; total: number } | null = null;
  return (step) => {
    const s = step.trim();
    const ready = COMPOSED_READY.exec(s);
    const started = COMPOSED.exec(s);
    if (ready) composed = { done: Number(ready[1]), total: Number(ready[2]) };
    else if (started && !composed) composed = { done: 0, total: Number(started[1]) };
    const c = ready ? { stage: last?.stage && LOOP.includes(last.stage) ? last.stage : "write" as Stage } : classifyStep(type, s);
    if (!c) return last;
    // Écrit : les lots tournent en parallèle ; celui qui s'écrit encore ne ramène pas le suivi à la
    // rédaction une fois la vérification commencée (« Vérification · 2/4 » puis « Rédaction · 4/4 »).
    if (last?.unit === "exercise" && last.stage === "check" && c.stage === "write") return last;
    const next: StageInfo = { key: "stage", ...c };
    if (composed && next.stage !== "render") Object.assign(next, { done: composed.done, total: composed.total, unit: "question" as const });
    else if (next.done === undefined && last?.done !== undefined && carries(last, next.stage)) {
      // Phrase sans compteur : le dernier compteur connu reste vrai (un QCM vérifié reste vérifié
      // pendant que le lot suivant s'écrit).
      Object.assign(next, { done: last.done, total: last.total, unit: last.unit });
    }
    last = next;
    return last;
  };
}
