import { resolveExamFormat } from "@/lib/exam-format";
import { completeJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { COURSE_MATTER_RULE, COURSE_TERMS_RULE, absentCourseTerms, coursePassages } from "@/lib/course-grounding";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";

export type Drill = {
  concept: string;
  statement_html: string;
  hints: string[]; // 5, du plus vague au plus précis
  solution_html: string;
  /** Notions nommées, écrites comme dans le cours (contrôlées dans le corpus, non affichées). */
  course_terms?: string[];
};

const DRILL_SCHEMA = {
  type: "object",
  properties: {
    concept: { type: "string" },
    statement_html: { type: "string", description: "Énoncé en HTML simple (p, ul, li, code, pre, table), 150 mots au plus." },
    hints: { type: "array", items: { type: "string" }, description: "EXACTEMENT 5 indices d'une ou deux phrases, du plus vague (nommer la technique) à l'étape décisive (jamais le corrigé)." },
    solution_html: { type: "string", description: "Corrigé en étapes courtes (<ol>, un tableau pour une trace), résultat final en tête de la dernière étape." },
    course_terms: { type: "array", items: { type: "string" }, description: "Les notions nommées de l'énoncé et du corrigé, chacune écrite EXACTEMENT comme dans les extraits du cours." },
  },
  required: ["concept", "statement_html", "hints", "solution_html", "course_terms"],
  additionalProperties: false,
} as const;

/**
 * Taille de la réponse, réflexion comprise (Sonnet 5 réfléchit par défaut, et sa réflexion compte
 * dans la limite) : à 6000 tokens et à l'effort par défaut, un drill Dijkstra/Bellman-Ford de
 * CS-250 sortait coupé trois fois de suite (21/11/2026). Effort moyen et format compact : la
 * réponse tient largement ; la relance après une coupure demande moins, pas la même chose.
 */
const DRILL_LIMITS = { maxTokens: 10_000, effort: "medium" } as const;
const DRILL_SHORT_LIMITS = { maxTokens: 6_000, effort: "low" } as const;

/** Consignes de longueur : chaque partie dit ce qu'elle contient, rien n'est écrit deux fois. */
const FORMAT_RULES = [
  `FORMAT COMPACT (la réponse entière doit rester courte : pas de prose répétée, rien d'écrit deux fois) :`,
  `- statement_html : 150 mots au plus. Choisis une instance PETITE (ex. graphe de 5-6 sommets, matrice 3×3, 4-6 lignes de code) : assez pour appliquer la méthode, pas pour la répéter.`,
  `- hints : EXACTEMENT 5 INDICES, une ou deux phrases chacun, révélés un par un. 1 = nommer la technique ; 2 = la propriété ou la définition du cours qui s'applique ; 3 = comment démarrer ; 4 = le piège ou le cas particulier ; 5 = L'ÉTAPE DÉCISIVE (le premier calcul clé ou l'invariant), JAMAIS le corrigé recopié.`,
  `- solution_html : le corrigé en 4 à 8 étapes courtes (<ol><li>), une ligne de justification chacune ; une trace d'algorithme va dans UN <table> (une ligne par itération), pas en phrases. Termine par le résultat final. 350 mots au plus.`,
].join("\n");

const SHORT_RULES = [
  `RÉPONSE PRÉCÉDENTE TROP LONGUE, coupée avant la fin : refais une question PLUS PETITE et un corrigé ABRÉGÉ.`,
  `- Instance minimale (ex. graphe de 4 sommets), énoncé de 80 mots au plus.`,
  `- 5 INDICES d'une seule phrase chacun, le 5e reste l'étape décisive.`,
  `- solution_html : 3 à 5 étapes d'une ligne (ou un seul petit <table>) et le résultat ; 150 mots au plus, aucune explication développée.`,
].join("\n");

/**
 * Formules d'un drill : son HTML s'affiche tel quel, sans rendu des maths (pas de « $…$ ») ;
 * « x_{t+1} » en texte nu se lisait mal, <sub>/<sup> s'affichent juste.
 */
const DRILL_FORMULA_RULE = `FORMULES : indices et exposants en <sub> et <sup> (x<sub>t+1</sub> = 2x<sub>t</sub>, 2<sup>16</sup>), jamais en texte nu (x_{t+1}, x^2) ni entre dollars.`;

/** Génère UNE question ciblée façon examen + 5 indices progressifs (via le LLM). */
export async function generateDrill(concept: string): Promise<Drill> {
  // Langue et style de l'examen du cours, lus avant les consignes (synchrones) du profil.
  await resolveExamFormat().catch(() => null);
  const p = profile();
  // DÉFINITIONS DU COURS : sans elles, le drill classait misuse/abuse ou issue/dilemma selon le web.
  const passages = await coursePassages([concept], 3, 900).catch(() => []);
  const prompt = (rules: string) => [
    p.qaIntro(),
    p.directivesBlock(),
    ``,
    `Génère UNE seule question d'entraînement ciblée sur : « ${concept} ».`,
    `Elle doit être APPLIQUÉE (calculer / tracer / remplir / justifier), au format et niveau ${p.drillLevel()}, en respectant les CONTRAINTES DURES ci-dessus.`,
    rules,
    `statement_html et solution_html en HTML SIMPLE (<p>,<ul>,<ol>,<li>,<code>,<pre>,<table>,<strong>,<sub>,<sup>). Pas d'images, pas de LaTeX.`,
    DRILL_FORMULA_RULE,
    COURSE_TERMS_RULE,
    COURSE_MATTER_RULE,
    passages.length ? `\n${DATA_RULE}` : null,
    passages.length ? dataBlock(`EXTRAITS DU COURS — les notions et définitions qui font foi`, passages) : null,
    `Réponds UNIQUEMENT avec l'objet JSON conforme au schéma. Aucun outil, aucun fichier.`,
    JSON.stringify(DRILL_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  // Sortie structurée quand le fournisseur l'offre ; sinon réponse lue par extractJson et
  // redemandée avec l'erreur si elle est illisible (énoncés avec code : cf. CS-290).
  const d = await completeJson<Drill>(
    { prompt: prompt(FORMAT_RULES), model: "opus", timeoutMs: 220_000, json: { schema: DRILL_SCHEMA }, ...DRILL_LIMITS },
    {
      check: async (v) => {
        if (!(typeof v?.statement_html === "string" && v.statement_html.trim() && typeof v.solution_html === "string" && v.solution_html.trim())) return "statement_html et solution_html (chaînes non vides) sont requis";
        // Le drill promet 5 indices révélés un par un : un tableau absent, court ou vide était livré
        // (remplacé par []) et facturé comme un drill complet.
        if (hintsOf(v).length < 5) return "hints doit contenir EXACTEMENT 5 indices (chaînes non vides), du plus vague à l'étape décisive";
        // Une notion que le cours ne présente pas est redemandée, avec son nom (lib/course-grounding).
        const absent = await absentCourseTerms(Array.isArray(v.course_terms) ? v.course_terms : []);
        return absent.length ? `notions absentes du cours : ${absent.join(", ")} — n'utilise que les notions et les définitions des extraits du cours` : null;
      },
      // Coupée : UNE relance qui demande moins (instance et corrigé abrégés), jamais la même demande.
      onTruncated: (req) => ({ ...req, prompt: prompt(SHORT_RULES), ...DRILL_SHORT_LIMITS }),
    },
  );
  delete d.course_terms;
  d.hints = hintsOf(d).slice(0, 5);
  return d;
}

/** Les indices utilisables d'une réponse : des chaînes non vides, rognées. */
function hintsOf(v: { hints?: unknown }): string[] {
  return Array.isArray(v?.hints) ? v.hints.filter((h): h is string => typeof h === "string" && !!h.trim()).map((h) => h.trim()) : [];
}
