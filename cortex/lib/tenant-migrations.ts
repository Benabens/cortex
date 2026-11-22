import { runWithCourse } from "@/db/client";
import { runWithUser } from "@/db/context";
import { authAll } from "@/db/auth-store";
import { dbDriverName, q } from "@/db/q";
import { TABLES } from "@/db/tables";
import { courseExists } from "@/lib/courses";
import { repairSearchIndex } from "@/lib/search";

/**
 * MIGRATIONS DE TOUS LES TENANTS CONNUS (prod-boot, étape B) : pour chaque ligne du registre
 * public.tenants, schéma rattrapé depuis db/tables.ts (CREATE TABLE IF NOT EXISTS + colonnes
 * manquantes), puis index de recherche réparé (lib/search repairSearchIndex). Les tenants neufs
 * restent amorcés au premier accès. Postgres seulement ; le cache des cours doit être chargé.
 */
export async function migrateTenants(log: (msg: string) => void = console.log): Promise<void> {
  if (dbDriverName() !== "postgres") return;
  // Le SELECT déclenche la création des tables du store auth (dont tenants).
  const rows = await authAll<{ user_id: string; course: string }>(
    "SELECT user_id, course FROM tenants ORDER BY user_id, course"
  );
  if (!rows.length) {
    log("migrations : aucun tenant enregistré (base neuve) — bootstrap lazy au premier accès");
    return;
  }
  for (const t of rows) {
    // Cours disparu (supprimé, ou registre resté après un échec de suppression) : on n'y touche
    // pas. Avant, normalizeCourse le remplaçait par cs-202 et la migration CRÉAIT un schéma cs-202
    // vide pour ce compte (et sa ligne de registre). scripts/diag-tenants.ts les liste.
    if (!courseExists(t.course)) {
      log(`ignoré : tenant ${t.user_id} × ${t.course} (cours inconnu : orphelin, cf. scripts/diag-tenants.ts)`);
      continue;
    }
    const repair = await runWithUser(t.user_id, () =>
      runWithCourse(t.course, async () => {
        for (const spec of TABLES) {
          await q.ensureTable(spec.name);
          await q.ensureColumns(spec.name, spec.cols.map((c) => c.name));
        }
        // Garde-fou de l'index de recherche (tenant migré ou hydraté sans text_norm : recherche
        // et ancrage des générations vides). Réparation de données dérivées, jamais bloquante.
        try {
          return await repairSearchIndex();
        } catch (e) {
          return e as Error;
        }
      })
    );
    log(`migré : tenant ${t.user_id} × ${t.course} (${TABLES.length} tables)`);
    if (repair instanceof Error) log(`  ⚠ index de recherche non vérifié : ${repair.message}`);
    else if (repair.textNorm || repair.vocab !== null) {
      log(`  ⚠ index de recherche réparé : ${repair.textNorm} passage(s) sans text_norm${repair.vocab !== null ? `, vocabulaire reconstruit (${repair.vocab} termes)` : ""}`);
    }
  }
}
