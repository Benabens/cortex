import fs from "node:fs";
import path from "node:path";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { dbDriverName } from "@/db/q";
import { OWNER_USER, userSlug, runWithUser } from "@/db/context";
import { runWithCourse } from "@/db/client";
import { dataRoot } from "@/lib/courses";
import { log } from "@/lib/metrics";

/**
 * SUPPRESSION DE COMPTE (RGPD — « Supprimer mon compte »).
 *
 * Efface TOUT ce qui appartient à un utilisateur, et rien d'autre. La garantie
 * d'isolation est structurelle : les schémas tenant et les dossiers de fichiers
 * portent un slug qui inclut un condensé de l'identifiant complet (db/context
 * userSlug) — dropper « le sien » ne peut pas toucher celui d'un autre compte.
 *
 * Ce qui est EFFACÉ :
 *  - `users`, `accounts` (OAuth), `verification_tokens` (par e-mail) → plus aucun
 *    moyen de se connecter ;
 *  - `courses` possédés, `tenants` (registre), `gen_events`, `credit_transactions` ;
 *  - chaque schéma tenant `t_<user>_<cours>` (Postgres, DROP … CASCADE) — donc
 *    sources, items, examens, faiblesses, planning, jobs, banque… d'un coup ;
 *  - tous les fichiers du volume sous `data/u/<slug>/` (données des cours créés +
 *    artefacts scopés : examens générés, captures). Les `refs` d'un cours partagé
 *    ne bougent pas (matériel commun, pas la propriété d'un compte).
 * Ce qui est ANONYMISÉ (pas effacé) : `llm_usage` — on garde tokens et coût pour
 *    la compta/observabilité, on retire le lien au compte (user_id → tombstone).
 *    Justification : une donnée financière agrégée n'a pas besoin de l'identité.
 * Les logs de requêtes (route.loop) ne sont pas une table : ce sont des lignes de
 *    log console (user/IP) qui expirent avec la rétention des logs — rien à purger.
 *
 * ATOMICITÉ : les schémas et fichiers ne sont pas transactionnels avec la base.
 * On efface d'abord les données lourdes best-effort (schémas, fichiers), on
 * ANNULE les jobs en cours (pour qu'aucun worker ne réécrive un fichier après
 * coup), puis on supprime les lignes globales — ce qui rend le compte inaccessible
 * quoi qu'il arrive. Un échec de drop/fichier n'annule pas la suppression : il est
 * LOGGÉ avec le nom exact (schéma/chemin) comme orphelin d'un compte supprimé
 * (rattrapage : comparer les schémas `t_*` et les dossiers `data/u/*` au registre).
 * Idempotent : un 2ᵉ appel ne trouve plus l'utilisateur → no-op.
 */

const TOMBSTONE = "__deleted__";
const JOB_ACTIVE = ["queued", "running", "verifying", "compiling"];

export type DeletionResult = {
  deleted: boolean;
  schemasDropped: number;
  filesDeleted: boolean;
  llmUsageAnonymized: number;
  errors: string[];
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

/** L'utilisateur est-il le PROPRIÉTAIRE de l'instance ? (précédence identique à
 *  db/courses-store resolveOwner). Le propriétaire ne peut pas s'auto-supprimer. */
export async function isOwnerAccount(userId: string): Promise<boolean> {
  const explicitId = process.env.CORTEX_OWNER_USER_ID?.trim();
  if (explicitId) return userId === explicitId;
  const email = process.env.CORTEX_OWNER_EMAIL?.trim();
  if (email) {
    const u = await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId).catch(() => undefined);
    return !!u?.email && u.email.toLowerCase() === email.toLowerCase();
  }
  return userId === OWNER_USER; // dev / défaut mono-utilisateur
}

/** Annule les jobs actifs de l'utilisateur (tue les workers) avant de dropper —
 *  sinon un worker en vol pourrait réécrire un fichier après l'effacement. */
async function cancelUserJobs(userId: string, courses: string[], errors: string[]): Promise<void> {
  const { cancelJob } = await import("@/lib/jobs");
  for (const course of courses) {
    try {
      const ids = await runWithUser(userId, () =>
        runWithCourse(course, async () => {
          const { q } = await import("@/db/q");
          return q.all<{ id: number }>(
            `SELECT id FROM jobs WHERE status IN ('queued','running','verifying','compiling')`,
          );
        }),
      );
      for (const { id } of ids) {
        await runWithUser(userId, () => runWithCourse(course, () => cancelJob(id))).catch((e) =>
          errors.push(`cancel job ${course}#${id}: ${msg(e)}`),
        );
      }
    } catch (e) {
      // La table jobs peut être absente / le schéma inaccessible : non bloquant.
      errors.push(`enum jobs ${course}: ${msg(e)}`);
    }
  }
}

export async function deleteAccount(userId: string): Promise<DeletionResult> {
  const errors: string[] = [];
  const empty: DeletionResult = { deleted: false, schemasDropped: 0, filesDeleted: false, llmUsageAnonymized: 0, errors };

  const user = await authGet<{ id: string; email: string | null }>(`SELECT id, email FROM users WHERE id = ?`, userId);
  if (!user) return empty; // déjà supprimé → idempotent

  // 1. Schémas tenant de l'utilisateur (registre = source de vérité).
  const tenants = await authAll<{ schema_name: string; course: string }>(
    `SELECT schema_name, course FROM tenants WHERE user_id = ?`, userId,
  );

  // 2. Arrêter proprement ses jobs en cours (best-effort).
  await cancelUserJobs(userId, [...new Set(tenants.map((t) => t.course))], errors);

  // 3. Dropper les schémas tenant (Postgres) — CASCADE efface toutes leurs tables.
  let schemasDropped = 0;
  if (dbDriverName() === "postgres") {
    for (const t of tenants) {
      try {
        await authRun(`DROP SCHEMA IF EXISTS "${t.schema_name}" CASCADE`);
        schemasDropped++;
      } catch (e) {
        errors.push(`drop schema ${t.schema_name}: ${msg(e)} (orphelin d'un compte supprimé — à balayer)`);
      }
    }
  }

  // 4. Effacer les fichiers du volume : data/u/<slug>/ (cours créés + artefacts).
  let filesDeleted = false;
  const userDir = path.join(dataRoot(), "u", userSlug(userId));
  try {
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
    filesDeleted = true;
  } catch (e) {
    errors.push(`rm ${userDir}: ${msg(e)} (orphelin d'un compte supprimé — à balayer)`);
  }

  // 5. Lignes globales : anonymiser l'usage, effacer le reste. La suppression de
  //    `users`/`accounts` rend le compte inaccessible quoi qu'il arrive plus haut.
  let llmUsageAnonymized = 0;
  try {
    const n = await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage WHERE user_id = ?`, userId);
    await authRun(`UPDATE llm_usage SET user_id = ? WHERE user_id = ?`, TOMBSTONE, userId);
    llmUsageAnonymized = Number(n?.n ?? 0);
    await authRun(`DELETE FROM accounts WHERE user_id = ?`, userId);
    if (user.email) await authRun(`DELETE FROM verification_tokens WHERE lower(identifier) = lower(?)`, user.email);
    await authRun(`DELETE FROM gen_events WHERE user_id = ?`, userId);
    await authRun(`DELETE FROM credit_transactions WHERE user_id = ?`, userId);
    await authRun(`DELETE FROM courses WHERE owner_user_id = ?`, userId);
    await authRun(`DELETE FROM tenants WHERE user_id = ?`, userId);
    await authRun(`DELETE FROM users WHERE id = ?`, userId);
  } catch (e) {
    // Échec du cœur transactionnel : le compte n'est PAS supprimé → on relève
    // pour que la route renvoie une erreur et que l'utilisateur réessaie (idempotent).
    log("error", "account.delete_failed", { message: msg(e) });
    throw new Error(`Suppression du compte échouée : ${msg(e)}`);
  }

  if (errors.length) log("warn", "account.delete_residue", { schemasDropped, filesDeleted, errors });
  log("info", "account.deleted", { schemasDropped, filesDeleted, llmUsageAnonymized, residues: errors.length });
  return { deleted: true, schemasDropped, filesDeleted, llmUsageAnonymized, errors };
}
