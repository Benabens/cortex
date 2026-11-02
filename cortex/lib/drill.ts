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
    statement_html: { type: "string", description: "Énoncé en HTML simple (p, ul, li, code, pre, table)." },
    hints: { type: "array", items: { type: "string" }, description: "EXACTEMENT 5 indices, du plus vague (nommer la technique) au plus précis (quasi la solution)." },
    solution_html: { type: "string", description: "Corrigé détaillé en HTML simple." },
    course_terms: { type: "array", items: { type: "string" }, description: "Les notions nommées de l'énoncé et du corrigé, chacune écrite EXACTEMENT comme dans les extraits du cours." },
  },
  required: ["concept", "statement_html", "hints", "solution_html", "course_terms"],
  additionalProperties: false,
} as const;

/** Génère UNE question ciblée façon examen CS-202 + 5 indices progressifs (via le LLM). */
export async function generateDrill(concept: string): Promise<Drill> {
  // Langue et style de l'examen du cours, lus avant les consignes (synchrones) du profil.
  await resolveExamFormat().catch(() => null);
  const p = profile();
  // DÉFINITIONS DU COURS : sans elles, le drill classait misuse/abuse ou issue/dilemma selon le web.
  const passages = await coursePassages([concept], 3, 900).catch(() => []);
  const prompt = [
    p.qaIntro(),
    p.directivesBlock(),
    ``,
    `Génère UNE seule question d'entraînement ciblée sur : « ${concept} ».`,
    `Elle doit être APPLIQUÉE (calculer / tracer / remplir / justifier), au format et niveau d'un vrai final EPFL, en respectant les CONTRAINTES DURES ci-dessus.`,
    `Fournis aussi une ÉCHELLE DE 5 INDICES, du plus vague (juste nommer la technique/le concept à utiliser) au plus précis (presque la solution complète, étape par étape) — ils seront révélés un par un.`,
    `statement_html et solution_html en HTML SIMPLE (<p>,<ul>,<li>,<code>,<pre>,<table>,<strong>). Pas d'images, pas de LaTeX.`,
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
    { prompt, model: "opus", timeoutMs: 220_000, json: { schema: DRILL_SCHEMA } },
    {
      check: async (v) => {
        if (!(typeof v?.statement_html === "string" && v.statement_html.trim() && typeof v.solution_html === "string")) return "statement_html et solution_html (chaînes) sont requis";
        // Une notion que le cours ne présente pas est redemandée, avec son nom (lib/course-grounding).
        const absent = await absentCourseTerms(Array.isArray(v.course_terms) ? v.course_terms : []);
        return absent.length ? `notions absentes du cours : ${absent.join(", ")} — n'utilise que les notions et les définitions des extraits du cours` : null;
      },
    },
  );
  delete d.course_terms;
  if (!Array.isArray(d.hints)) d.hints = [];
  d.hints = d.hints.slice(0, 5);
  return d;
}
