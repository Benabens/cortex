/**
 * Fusionne le WAL dans le fichier .db principal (à faire AVANT un commit de la base,
 * sinon les écritures récentes restent dans cortex.db-wal et seraient perdues).
 * Lancer : npm run db:checkpoint
 */
import { sqlite } from "../db/client";

sqlite.pragma("wal_checkpoint(TRUNCATE)");
console.log("✓ Checkpoint WAL effectué (base prête à être commitée).");
