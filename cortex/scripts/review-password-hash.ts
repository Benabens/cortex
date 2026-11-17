/**
 * HASH DU MOT DE PASSE RELECTEUR → valeur de REVIEW_LOGIN_PASSWORD_HASH (lib/review-login).
 *
 *   cd cortex && npx tsx scripts/review-password-hash.ts
 *
 * Le mot de passe est SAISI AU CLAVIER, sans écho, deux fois. Il n'est jamais
 * accepté en argument (il resterait dans l'historique du shell et dans `ps`) ni
 * écrit nulle part : seule la ligne du hash sort, sur la sortie standard. Hors
 * terminal (entrée redirigée), la première ligne de l'entrée standard est lue.
 *
 * Mot de passe conseillé : tiré au hasard, ≥ 20 caractères, rangé dans le
 * gestionnaire de l'éditeur, donné aux relecteurs dans le champ prévu du
 * formulaire de soumission, jamais dans le dépôt.
 */
import { hashReviewPassword, verifyReviewPassword } from "../lib/review-login";

const MIN_LENGTH = 16;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("interrompu"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let all = "";
  for await (const chunk of process.stdin) all += chunk;
  return all.split(/\r?\n/)[0] ?? "";
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error("aucun argument : le mot de passe se saisit au clavier (jamais en ligne de commande).");
  }
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden("Mot de passe relecteur : ");
    const again = await readHidden("Encore une fois : ");
    if (again !== password) throw new Error("les deux saisies diffèrent.");
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) throw new Error(`mot de passe trop court (${MIN_LENGTH} caractères minimum).`);
  const hash = await hashReviewPassword(password);
  if (!(await verifyReviewPassword(password, hash))) throw new Error("vérification du hash échouée.");
  process.stderr.write("À poser dans REVIEW_LOGIN_PASSWORD_HASH (variable du service, jamais dans le dépôt) :\n");
  process.stdout.write(`${hash}\n`);
}

main().catch((e) => {
  process.stderr.write(`review-password-hash : ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
