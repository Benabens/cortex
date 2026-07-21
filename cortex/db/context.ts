import { AsyncLocalStorage } from "node:async_hooks";
import { currentCourse } from "./client";

/**
 * Contexte UTILISATEUR (Phase B — multi-tenant), symétrique du contexte cours
 * de db/client.ts. Porté par AsyncLocalStorage : chaque requête HTTP/chaque
 * script a son utilisateur courant, résolu par le middleware d'auth (B4).
 *
 * Dev mono-user (DB_DRIVER=sqlite) : l'utilisateur est toujours "owner" — les
 * fichiers data/<cours>.db restent l'unique tenant, comportement historique.
 */

const userCtx = new AsyncLocalStorage<string>();

export const OWNER_USER = "owner";

/** Utilisateur courant : contexte ALS → env CORTEX_USER (scripts) → "owner". */
export function currentUser(): string {
  return userCtx.getStore() ?? process.env.CORTEX_USER ?? OWNER_USER;
}

/** Exécute `fn` avec un utilisateur courant donné (propagé aux await). */
export function runWithUser<T>(userId: string | null | undefined, fn: () => T): T {
  return userCtx.run(userId || OWNER_USER, fn);
}

/** Installe l'utilisateur courant pour le reste de la chaîne async (routes). */
export function enterUser(userId: string | null | undefined): string {
  const u = userId || OWNER_USER;
  userCtx.enterWith(u);
  return u;
}

/** Nom d'identifiant PG sûr ([a-z0-9_], ≤ 63 chars, ne commence pas par un chiffre). */
function pgIdent(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "u" + s;
  return s.slice(0, 28);
}

/**
 * Identifiant NORMALISÉ d'un utilisateur, partagé par le schéma Postgres et
 * par les dossiers d'artefacts (lib/courses). Deux comptes qui se réduisent au
 * même slug partagent alors TOUT (base ET disque) au lieu de partager l'un
 * sans l'autre — c'est la troncature qui doit être unique, pas seulement le
 * chemin : on suffixe donc un condensé de l'identifiant complet.
 */
export function userSlug(userId: string): string {
  const base = pgIdent(userId);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const h = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `${base.slice(0, 19)}_${h}`;
}

/**
 * Schéma Postgres du tenant courant : t_<user>_<cours>.
 * Isolation STRUCTURELLE (schema-per-tenant) : le search_path de la connexion
 * détermine seul ce qui est visible — aucune requête applicative à réécrire,
 * aucun WHERE user_id à ne jamais oublier. Miroir du modèle « un fichier
 * SQLite par cours » du mode dev.
 */
export function tenantSchema(userId?: string, courseId?: string): string {
  // userSlug (tronqué + condensé) garantit qu'une troncature ne fusionne pas
  // deux comptes distincts — la même fonction nomme leurs dossiers d'artefacts.
  return `t_${userSlug(userId ?? currentUser())}_${pgIdent(courseId ?? currentCourse())}`;
}
