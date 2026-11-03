/**
 * PREUVES DU COURS POUR LE CORRECTEUR QCM — banc HUM-285 du 02/11/2026 : 22 à 27 questions
 * justes rejetées « hors cours » par examen. Le correcteur ne voyait que deux extraits de 700
 * caractères par sujet, découpés autour du premier mot du sujet : « Svenson (1981) n'apparaît
 * dans aucun extrait », « la phrase s'arrête à “Thaler et Sunstei” ». Ici :
 *  - `verifierPassages` : les passages où se trouve le fait que teste chaque question (son
 *    `source_fact`), puis son énoncé et sa clé, puis son sujet, en fenêtres larges ;
 *  - `secondLookOffCourse` : avant de rejeter une question que le correcteur juge hors cours,
 *    les notions qu'il dit absentes sont cherchées dans TOUT le cours, et un second regard
 *    tranche sur ces passages. En cas d'échec, le rejet tient : jamais de hors-cours laissé
 *    passer faute d'avoir pu vérifier.
 * Le contrôle déterministe des notions de la clé (absentCourseTerms) reste en amont, inchangé.
 */
import { evidencePassages } from "@/lib/course-grounding";
import { completeJson } from "@/lib/llm";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";

type Question = { topic?: string | null; stem: string; options: string[]; correct: number[]; sourceFact?: string | null };

/**
 * Extraits que voit le correcteur pour un lot : le fait de chaque question d'abord, ses mots
 * ensuite (énoncé et TOUTES les options : centrer sur la clé orienterait une résolution qui se
 * veut à l'aveugle), son sujet en dernier.
 */
export async function verifierPassages(items: Question[]): Promise<{ src: string; text: string }[]> {
  const facts = items.map((it) => it.sourceFact ?? "");
  const stems = items.map((it) => `${it.stem} ${it.options.join(" ")}`);
  const topics = [...new Set(items.map((it) => it.topic ?? "").filter(Boolean))];
  return evidencePassages([...facts, ...stems, ...topics], { perQuery: 2, cap: 1800, budget: 24_000 });
}

/** Une question que le correcteur juge hors cours : `reason`, ce qu'il en dit ; `terms`, ce qu'il dit absent. */
export type OffCourseFlag = Question & { explanation?: string | null; reason: string; terms: string[] };

const SECOND_LOOK_SCHEMA = {
  type: "object",
  properties: {
    second_look: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          off_course: { type: "string", description: "La notion ou le fait que la question NOMME et que le cours ne présente pas (ou définit autrement), et ce que dit le cours. Vide si les passages le contiennent." },
        },
        required: ["index", "off_course"],
        additionalProperties: false,
      },
    },
  },
  required: ["second_look"],
  additionalProperties: false,
} as const;

/** Les notions entre guillemets d'un signalement, à défaut de termes donnés par le correcteur. */
function quoted(flag: string): string[] {
  return [...flag.matchAll(/[«“"]\s*([^»”"]{3,80}?)\s*[»”"]/g)].map((m) => m[1]);
}

/**
 * Second regard sur les questions jugées hors cours, avec les passages trouvés dans tout le
 * cours pour ce que le correcteur dit absent. Rend, par question (même ordre), la raison
 * confirmée (non vide = hors cours) ou "" (fondée sur le cours). Une question dont la notion
 * n'a AUCUN passage dans le cours reste hors cours sans appel au modèle ; si le second regard
 * échoue, toutes gardent le rejet du correcteur.
 */
export async function secondLookOffCourse(flags: OffCourseFlag[]): Promise<string[]> {
  // Les notions nommées par le correcteur, celles qu'il cite entre guillemets (une définition
  // contestée, PR #55), puis sa phrase elle-même : chaque signalement a ses propres passages.
  const evidence = await Promise.all(flags.map((f) => {
    const queries = [...new Set([...f.terms, ...quoted(f.reason), f.reason])];
    return evidencePassages(queries, { perQuery: 3, cap: 2000, budget: 10_000 }).catch(() => []);
  }));
  const verdicts = flags.map((f) => f.reason);
  const open = flags.map((f, i) => ({ f, i })).filter((x) => evidence[x.i].length);
  if (!open.length) return verdicts;
  const seen = new Set<string>();
  const passages = open.flatMap((x) => evidence[x.i]).filter((p) => !seen.has(p.text) && !!seen.add(p.text));
  const block = open.map(({ f }, i) => [
    `Q${i}. ${sanitizeCorpus(f.stem)}`,
    ...f.options.map((o, k) => `   (${k}) ${sanitizeCorpus(o)}`),
    `   [clé : ${(f.correct ?? []).join(", ")}]`,
    f.explanation ? `   [explication : ${sanitizeCorpus(f.explanation).slice(0, 600)}]` : "",
    `   [jugée hors cours : ${sanitizeCorpus(f.reason).slice(0, 300)}]`,
  ].filter(Boolean).join("\n")).join("\n\n");
  const prompt = [
    `Un premier correcteur, qui ne voyait que de courts extraits du cours, a jugé les questions ci-dessous hors cours. Voici des passages trouvés pour ces notions dans TOUT le cours.`,
    `Pour chaque question, off_course : la notion ou le fait que la bonne réponse, l'explication ou une option NOMME et que le cours ne présente pas, ou que le cours définit autrement, avec ce que dit le cours. Laisse-le VIDE si les passages contiennent cette notion ou ce fait avec la même définition.`,
    `Une option qui n'est qu'une affirmation fausse (résultat inversé, condition changée, chiffre ou auteur déplacé) n'est pas hors cours : c'est le rôle d'un distracteur.`,
    ``,
    DATA_RULE,
    dataBlock(`PASSAGES DU COURS`, passages),
    ``,
    `═══ QUESTIONS JUGÉES HORS COURS ═══`,
    block,
    ``,
    // Pas de schéma recopié ici : le format tient en une ligne (le fournisseur CLI ignore le schéma).
    `Réponds UNIQUEMENT avec l'objet JSON {"second_look": [{"index": i, "off_course": "…"}]}, une entrée par question.`,
  ].join("\n");
  try {
    const r = await completeJson<{ second_look: { index: number; off_course?: string }[] }>(
      { prompt, model: "opus", timeoutMs: 300_000, json: { schema: SECOND_LOOK_SCHEMA } },
      { check: (v) => (Array.isArray(v?.second_look) ? null : "le champ « second_look » (tableau) manque") },
    );
    const byIndex = new Map(r.second_look.filter((x) => Number.isInteger(x?.index)).map((x) => [x.index, typeof x.off_course === "string" ? x.off_course.trim() : null]));
    // Une question sans réponse du second regard garde le signalement du correcteur.
    open.forEach(({ i }, k) => {
      const v = byIndex.get(k);
      if (typeof v === "string") verdicts[i] = v;
    });
  } catch {
    // Second regard illisible ou en échec : le rejet du correcteur tient.
  }
  return verdicts;
}
