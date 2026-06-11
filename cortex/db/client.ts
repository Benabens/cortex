import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { courseDbPath, DEFAULT_COURSE, normalizeCourse } from "../lib/courses";
import * as schema from "./schema";

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
 * pas de fuite entre requêtes. Cours inconnu → cs-202.
 */
export function enterCourse(courseId: string | null | undefined): string {
  const c = normalizeCourse(courseId);
  courseCtx.enterWith(c);
  return c;
}

// ---- schéma de base pour les DB NEUVES (cours ≠ cs-202) ----
// Lu depuis les migrations Drizzle, rendu idempotent (IF NOT EXISTS) → applicable sans risque.
// cs-202 NE passe JAMAIS par là (sa DB est déjà migrée et committée).
function baseSchemaSql(): string {
  try {
    const dir = path.join(process.cwd(), "db", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const raw = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    return raw
      .replace(/CREATE TABLE\s+`/g, "CREATE TABLE IF NOT EXISTS `")
      .replace(/CREATE UNIQUE INDEX\s+`/g, "CREATE UNIQUE INDEX IF NOT EXISTS `")
      .replace(/CREATE INDEX\s+`/g, "CREATE INDEX IF NOT EXISTS `");
  } catch {
    return "";
  }
}

function applyBaseSchema(d: Database.Database) {
  const sql = baseSchemaSql();
  if (!sql) return;
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) try { d.exec(s); } catch { /* déjà présent / FK paresseuse : on continue */ }
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

// cs-202 pré-ouverte = data/cortex.db (identique au singleton historique). drizzle reste lié à cs-202.
const cs202 = conn(DEFAULT_COURSE);
export const db = drizzle(cs202, { schema });

/** Connexion brute du cours courant (rare ; préférer `sqlite`). */
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

/** Table virtuelle FTS5 pour la recherche globale (créée à la main, hors Drizzle), sur la DB courante. */
export function ensureFts() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
      title, text, lecture_id UNINDEXED, item_id UNINDEXED, source_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}
