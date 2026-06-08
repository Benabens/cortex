/**
 * Contexte des faiblesses pour que Claude Code (moi) les analyse.
 *  - sans argument : liste TOUTES les faiblesses à analyser (analyzed=0).
 *  - avec un <id>  : détaille cette faiblesse.
 * Pour chaque faiblesse : sujet + note + chemin du screenshot (que je lis comme image).
 * Lancer : npm run weakness:brief         (toutes les pending)
 *          npm run weakness:brief -- <id>  (une seule)
 */
import path from "node:path";
import { sqlite } from "../db/client";
import { listPending } from "../lib/weaknesses";

const upDir = (p: string) => path.join(process.cwd(), "data", "uploads", p);

const idArg = process.argv[2];
if (idArg) {
  const w = sqlite
    .prepare("SELECT id, topic, description, screenshot_path FROM weaknesses WHERE id = ?")
    .get(Number(idArg)) as any;
  if (!w) {
    console.error("faiblesse introuvable");
    process.exit(1);
  }
  print(w.id, w.topic, w.description, w.screenshot_path);
} else {
  const pending = listPending();
  if (!pending.length) {
    console.log("Aucune faiblesse à analyser (tout est déjà traité).");
    process.exit(0);
  }
  console.log(`${pending.length} faiblesse(s) à analyser :\n`);
  for (const w of pending) print(w.id, w.topic, w.description, w.screenshotPath);
}

function print(id: number, topic: string, description: string | null, screenshot: string | null) {
  console.log(`--- FAIBLESSE #${id} ---`);
  console.log("TOPIC:", topic || "(à déduire)");
  console.log("NOTE:", description || "(aucune)");
  console.log("SCREENSHOT:", screenshot ? upDir(screenshot) : "(aucun)");
  console.log("");
}
