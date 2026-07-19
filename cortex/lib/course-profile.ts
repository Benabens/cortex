import { currentCourse } from "@/db/client";
import type { Archetype } from "@/lib/archetypes";

/**
 * Profil de génération PAR COURS : tous les morceaux de prompt/format spécifiques à une
 * matière (intro, structure, contrat LaTeX, archétypes, directives, ancrage visuel).
 *
 * ⚠️ Le profil cs-202 (lib/profiles/cs202.ts) renvoie EXACTEMENT les textes historiques
 * → le prompt cs-202 reste byte-identique. Les autres cours ont leur profil propre
 * (pas de \examtopo réseau ni d'inode OS forcés ; archétypes & figures de la matière).
 */
export type Slot = { category: string; points: number; brief: string; mold?: string | null };

export type CourseProfile = {
  /** Bloc de contraintes dures en tête du prompt. */
  directivesBlock(): string;
  /** Ancrage visuel (images-étalon). Vide si le cours n'en a pas. */
  visionBlock(): string;
  /** Texte des notes/study-guide ingérées (scope). */
  staffNotesText(max: number): Promise<string>;
  /** Image de la page-étalon du même type qu'un exo (vision ciblée), ou null. */
  refImageFor(category?: string, concept?: string): string | null;
  /** Contrat LaTeX (macros disponibles, conventions, grilles). */
  latexContract(): string;
  /** Archétypes de questions de la matière. */
  archetypes: Archetype[];
  /** Slots de repli (si le blueprint échoue). */
  examSlots(): Promise<Slot[]>;
  /** Blueprint : 6 slots pondérés (faiblesses × poids). */
  buildBlueprint(): Promise<Slot[]>;
  /** Intro + structure du prompt complet (lignes). */
  promptIntroFull(): string[];
  /** Intro du prompt par lots (lignes). */
  promptIntroBatch(n: number): string[];
  /** Amorce du prompt d'un exercice ciblé (lignes). */
  exerciseLead(target: string, a: Archetype, pts: number, refImage: string | null): string[];
  /** Amorce du prompt de régénération d'un exercice (lignes). */
  regenLead(category: string | undefined, concept: string, points: number | undefined, diagnostic: string, refImage: string | null): string[];
  /** Intro courte pour drilling / vérification / correction (« Tu es … »). */
  qaIntro(): string;
};

// Import paresseux des profils pour éviter tout cycle au chargement.
import { cs202Profile } from "@/lib/profiles/cs202";
import { algoProfile } from "@/lib/profiles/algo";
import { mlProfile } from "@/lib/profiles/ml";
import { makeGenericProfile, genericArchetypes } from "@/lib/profiles/generic";
import { DEFAULT_COURSE, COURSES } from "@/lib/courses";

const PROFILES: Record<string, CourseProfile> = {
  "cs-202": cs202Profile,
  algo: algoProfile,
  ml: mlProfile,
};

// moteur-v2 (P5) — cache des profils génériques construits à la volée (onboarding zéro-code).
const GENERIC_CACHE = new Map<string, CourseProfile>();

/**
 * Profil d'un cours. moteur-v2 : un cours ENREGISTRÉ (lib/courses.ts) sans module de profil dédié
 * reçoit un PROFIL GÉNÉRIQUE à archétypes neutres (l'ADN détecté fait le reste) — il ne retombe
 * PLUS sur le profil cs-202 (défaut de généricité historique). Hors registre → cs-202 (historique).
 */
export function getProfile(courseId?: string): CourseProfile {
  const id = courseId ?? "";
  const hit = PROFILES[id];
  if (hit) return hit;
  if (id && id !== DEFAULT_COURSE && COURSES[id]) {
    let g = GENERIC_CACHE.get(id);
    if (!g) { g = makeGenericProfile(id, genericArchetypes()); GENERIC_CACHE.set(id, g); }
    return g;
  }
  return cs202Profile;
}

/** Profil du cours courant. */
export function profile(): CourseProfile {
  return getProfile(currentCourse());
}
