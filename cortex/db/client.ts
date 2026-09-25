import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { courseDbPath, DEFAULT_COURSE } from "../lib/courses";
import path from "node:path";
import { allDdl } from "./tables";

/**
 * Client DB MULTI-COURS. Une connexion SQLite PAR COURS, ouverte à la demande.
 *
 * ⚠️ RÈGLE D'OR (isolation totale de cs-202) :
 *  - `cs-202` ouvre EXACTEMENT `data/cortex.db` avec les mêmes pragmas qu'avant : connexion
 *    byte-compatible avec le singleton historique. Son schéma n'est JAMAIS modifié ici.
 *  - Les autres cours ouvrent `data/<id>/...db` (créées à la volée, schéma de base appliqué).
 *  - Le « cours courant » est porté par AsyncLocalStorage (propagé à travers les await des
 *    routes) ; à défaut `process.env.CORTEX_COURSE` (scripts/worker) ; à défaut `cs-202`.
 *  - `sqlite` est un Proxy qui délègue à la connexion du cours courant. Tout `import { sqlite }`
 *    existant fonctionne sans changement ; sans contexte de cours → cs-202 (comportement d'avant).
 */

const courseCtx = new AsyncLocalStorage<string>();

/** Exécute `fn` avec un cours courant donné (propagé aux await). */
export function runWithCourse<T>(courseId: string | null | undefined, fn: () => T): T {
  return courseCtx.run(courseId || DEFAULT_COURSE, fn);
}

/** Cours courant : contexte ALS → env CORTEX_COURSE → cs-202. */
export function currentCourse(): string {
  return courseCtx.getStore() ?? process.env.CORTEX_COURSE ?? DEFAULT_COURSE;
}

/**
 * Installe le cours courant pour le reste de l'exécution asynchrone en cours
 * (ex. 1ʳᵉ ligne d'un route handler). Chaque requête HTTP a sa propre chaîne async →
 * pas de fuite entre requêtes.
 *
 * Un identifiant INCONNU est installé TEL QUEL, il n'est plus remplacé par
 * cs-202 — un repli silencieux servait la matière d'un autre compte. La première
 * lecture échouera avec une erreur explicite (cf. lib/courses getCourse).
 */
export function enterCourse(courseId: string | null | undefined): string {
  const c = courseId || DEFAULT_COURSE;
  courseCtx.enterWith(c);
  return c;
}

// ---- schéma de base pour les DB NEUVES (cours ≠ cs-202) ----
// Source de vérité : db/tables.ts (schéma COMPLET, y compris les ex-tables lazy).
// cs-202 NE passe JAMAIS par là (sa DB est déjà migrée et committée).
function applyBaseSchema(d: Database.Database) {
  for (const stmt of allDdl("sqlite")) {
    try { d.exec(stmt); } catch { /* déjà présent / FK paresseuse : on continue */ }
  }
}

const connections = new Map<string, Database.Database>();

function openConnection(courseId: string): Database.Database {
  const file = courseDbPath(courseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isNew = courseId !== DEFAULT_COURSE && !fs.existsSync(file);
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  // le worker de job (autre process) écrit pendant que le serveur lit → patiente au lieu d'échouer
  d.pragma("busy_timeout = 8000");
  // cs-202 : schéma déjà en place (committé) → on n'y touche pas. Autres cours neufs : schéma de base.
  if (isNew) applyBaseSchema(d);
  return d;
}

function conn(courseId: string): Database.Database {
  let c = connections.get(courseId);
  if (!c) {
    c = openConnection(courseId);
    connections.set(courseId, c);
  }
  return c;
}

/** Connexion brute du cours courant (rare ; préférer la façade async `q` de db/q). */
export function rawDb(): Database.Database {
  return conn(currentCourse());
}

/**
 * `sqlite` : proxy qui délègue chaque accès à la connexion du cours courant.
 * Les méthodes (prepare/exec/transaction/pragma) sont liées à la vraie connexion,
 * donc les Statement préparés appartiennent bien à la bonne DB.
 */
export const sqlite = new Proxy({} as Database.Database, {
  get(_t, prop) {
    const target = conn(currentCourse());
    const v = (target as any)[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
  set(_t, prop, value) {
    (conn(currentCourse()) as any)[prop] = value;
    return true;
  },
});

/** Table virtuelle FTS5 pour la recherche globale (SQLite uniquement — en mode
 * postgres la recherche est un index GIN tsvector sur items.text_norm, cf.
 * db/driver-postgres + lib/search). */
export function ensureFts() {
  if ((process.env.DB_DRIVER ?? "sqlite") !== "sqlite") return;
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
      title, text, lecture_id UNINDEXED, item_id UNINDEXED, source_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}
