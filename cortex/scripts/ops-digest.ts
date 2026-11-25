/**
 * Bilan d'exploitation par e-mail (lib/ops-digest), à la main :
 *   npx tsx scripts/ops-digest.ts --dry-run   affiche le mail du jour, n'envoie rien
 *   npx tsx scripts/ops-digest.ts --test      l'envoie tout de suite (sujet « [test] »), bilan de
 *                                             la semaine compris, sans clore le passage du jour
 *   npx tsx scripts/ops-digest.ts             passage normal : heure, jour et envoi unique respectés
 * En prod, dans le conteneur (base et Resend de l'app) :
 *   railway ssh --service cortex-app -- npx tsx scripts/ops-digest.ts --test
 * Aucun appel au modèle. Destinataire : OPS_DIGEST_TO, sinon CORTEX_OWNER_EMAIL / PUBLISHER_EMAIL.
 */
import { runOpsDigest } from "../lib/ops-digest";

(async () => {
  const dryRun = process.argv.includes("--dry-run");
  const test = process.argv.includes("--test");
  const r = await runOpsDigest({ dryRun, test });
  if (dryRun) console.log(`${r.subject ?? "(rien)"}\n\n${r.reason ?? ""}`);
  else console.log(`[ops-digest] ${r.status}${r.subject ? ` — ${r.subject}` : ""}${r.reason && r.status === "failed" ? ` (${r.reason})` : ""}`);
  process.exit(r.status === "failed" ? 1 : 0);
})().catch((e) => { console.error("[ops-digest] échec :", (e as Error)?.message ?? e); process.exit(1); });
