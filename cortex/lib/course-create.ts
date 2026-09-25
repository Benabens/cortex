import { listCourses } from "@/lib/courses";
import type { CourseRow } from "@/db/courses-store";
import { nowStr } from "@/db/q";

/**
 * CRÉATION D'UN COURS depuis l'interface — validation des champs et fabrication
 * du slug. Isolé de la route pour être testable sans HTTP.
 */

export type CourseInput = {
  name?: unknown;
  code?: unknown;
  university?: unknown;
  teachers?: unknown;
  language?: unknown;
  examDate?: unknown;
  durationMin?: unknown;
};

export class InvalidCourseError extends Error {}

const LANGS = new Set(["fr", "en", "de", "it", "es", "pt", "nl"]);

/** Identifiants réservés : ils serviraient de segment d'URL ou de dossier. */
const RESERVED = new Set(["new", "nouveau", "api", "admin", "cours", "u", "data", "refs", "exams", "uploads"]);

function str(v: unknown, field: string, { max, required = false }: { max: number; required?: boolean }): string {
  if (v === undefined || v === null) {
    if (required) throw new InvalidCourseError(`Le champ « ${field} » est obligatoire.`);
    return "";
  }
  if (typeof v !== "string") throw new InvalidCourseError(`Le champ « ${field} » doit être du texte.`);
  const s = v.trim().replace(/\s+/g, " ");
  if (required && s.length < 2) throw new InvalidCourseError(`Le champ « ${field} » est trop court.`);
  if (s.length > max) throw new InvalidCourseError(`Le champ « ${field} » dépasse ${max} caractères.`);
  return s;
}

/** Liste d'enseignant·es : tableau JSON ou saisie libre séparée par des virgules. */
export function parseTeachers(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.split(",") : [];
  const out = raw.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 12);
  for (const t of out) {
    if (t.length > 60) throw new InvalidCourseError("Un nom d'enseignant·e dépasse 60 caractères.");
  }
  return out;
}

/** Slug ASCII, sans accent ni ponctuation — il devient un segment de chemin et de schéma SQL. */
export function slugify(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Slug LIBRE. L'unicité est GLOBALE, pas seulement par utilisateur : l'id d'un
 * cours nomme aussi son dossier sur disque et son schéma Postgres. Deux comptes
 * qui choisissent le même intitulé obtiennent donc deux identifiants distincts.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const root = base || "cours";
  if (!taken.has(root) && !RESERVED.has(root)) return root;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Repli : suffixe aléatoire court (collision massive = intitulé très répandu).
  let s = "";
  do {
    s = `${root}-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(s));
  return s;
}

/** Abréviation pour le sélecteur quand aucun code d'examen n'est donné. */
function shortLabel(name: string, code: string): string {
  if (code) return code;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 10);
  return words.map((w) => w[0].toUpperCase()).join("").slice(0, 5);
}

/**
 * Valide l'entrée et fabrique la ligne à insérer. Les chemins restent NULL :
 * un cours créé ici est rangé sous son propriétaire (cf. lib/courses coursePaths),
 * jamais dans un dossier partagé.
 */
export function buildCourseRow(input: CourseInput, ownerUserId: string): CourseRow {
  const name = str(input.name, "nom", { max: 80, required: true });
  const code = str(input.code, "code", { max: 24 });
  const university = str(input.university, "université", { max: 80 });
  const teachers = parseTeachers(input.teachers);
  const language = str(input.language, "langue", { max: 5 }).toLowerCase() || "fr";
  if (!LANGS.has(language)) throw new InvalidCourseError(`Langue non reconnue : « ${language} ».`);

  const examDate = str(input.examDate, "date d'examen", { max: 10 });
  if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
    throw new InvalidCourseError("La date d'examen doit être au format AAAA-MM-JJ.");
  }
  const durationMin = input.durationMin === undefined || input.durationMin === null || input.durationMin === ""
    ? 180
    : Number(input.durationMin);
  if (!Number.isFinite(durationMin) || durationMin < 15 || durationMin > 600) {
    throw new InvalidCourseError("La durée doit être comprise entre 15 et 600 minutes.");
  }

  const taken = new Set(listCourses().map((c) => c.id));
  // Le slug vient du NOM (« Analyse 3 » → « analyse-3 ») ; le code n'entre en jeu
  // que pour départager deux intitulés identiques.
  const id = uniqueSlug(slugify(name) || slugify(code), taken);

  return {
    id,
    owner_user_id: ownerUserId,
    name,
    short: shortLabel(name, code),
    code: code || null,
    exam_name: name,
    exam_kind: "Examen final",
    university: university || null,
    university_lines: JSON.stringify(university ? [university] : []),
    faculty: null,
    teachers: JSON.stringify(teachers),
    language,
    // Aucun profil curaté : le moteur dérive le format de l'ADN des annales
    // importées (lib/profiles/generic) — c'est le chemin par défaut du produit.
    profile_id: null,
    duration_min: Math.round(durationMin),
    exam_date: examDate || null,
    db_file: null,
    refs_rel: null,
    exams_rel: null,
    uploads_rel: null,
    content_rel: null,
    created_at: nowStr(),
  };
}
