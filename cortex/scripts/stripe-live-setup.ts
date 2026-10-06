/**
 * STRIPE POUR CORTEX — produits, prix, portail client, webhook, puis clés dans
 * Railway. Lancé par scripts/golive-ben.sh (racine du dépôt), qui demande les
 * clés en saisie masquée et les lui passe sur l'ENTRÉE STANDARD (--keys-stdin :
 * première ligne = clé de mise en place, qui écrit dans Stripe ; seconde ligne =
 * clé de l'app, vide = la même). Ni argument ni variable d'environnement : rien
 * de ce que ce processus lance, ni le lanceur tsx lui-même, ne les voit. Rien
 * n'est écrit sur disque, aucun secret n'est affiché, et la CLI Railway reçoit
 * chaque valeur sur son entrée standard.
 *
 * Usage (par le script guidé) :
 *   tsx scripts/stripe-live-setup.ts --site https://app.cortexexam.com --landing https://cortexexam.com \
 *     --legacy-host ancien-hote.up.railway.app --railway-project <id> --railway-service <nom> --railway-environment production
 *
 * Options :
 *   --keys-stdin       lire les deux clés sur l'entrée standard (sinon STRIPE_SETUP_KEY / STRIPE_RUNTIME_KEY)
 *   --dry-run          lectures seules (sans clé : décrit seulement ce qui serait fait)
 *   --test             sur la sandbox (clés *_test_), sans toucher à Railway
 *   --rotate-webhook   supprime et recrée le webhook : seule façon d'obtenir un nouveau secret
 *   --no-railway       ne pousse rien dans Railway
 *
 * Idempotent : relancé, il ne recrée rien. La logique est dans
 * lib/billing/stripe-setup.ts (testée sans réseau) ; la marche à suivre dans
 * docs/STRIPE-LIVE.md.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../lib/billing/stripe-client";
import { OFFERS, missingRuntimeAccess, setupStripe } from "../lib/billing/stripe-setup";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const test = flag("--test");
const dryRun = flag("--dry-run");
const noRailway = flag("--no-railway") || test || dryRun;
const mode = test ? "test" : "live";
const site = (value("--site") ?? "").replace(/\/+$/, "");
const landing = (value("--landing") ?? "").replace(/\/+$/, "");
const legacyHosts = values("--legacy-host");
const railway = { project: value("--railway-project"), service: value("--railway-service"), environment: value("--railway-environment") };

// Les clés arrivent par l'entrée standard et ne vivent que dans la mémoire de ce
// processus. (Repli par l'environnement pour un lancement à la main : effacé
// aussitôt, mais le lanceur tsx l'a alors vu passer.)
const piped = flag("--keys-stdin") ? fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()) : [];
const setupKey = piped[0] ?? process.env.STRIPE_SETUP_KEY ?? "";
let runtimeKey = piped[1] ?? process.env.STRIPE_RUNTIME_KEY ?? "";
delete process.env.STRIPE_SETUP_KEY;
delete process.env.STRIPE_RUNTIME_KEY;

if (!site || !landing) die("--site et --landing sont requis (ex. --site https://app.cortexexam.com --landing https://cortexexam.com).");
if (!test && /localhost|127\.0\.0\.1/.test(site)) die(`En live, le webhook doit viser l'adresse publique, pas « ${site} ».`);
if (!noRailway && !(railway.project && railway.service && railway.environment)) {
  die("--railway-project, --railway-service et --railway-environment sont requis pour poser les clés (ou --no-railway).");
}

if (!setupKey) {
  if (!dryRun) die("Aucune clé de mise en place.");
  // Essai à blanc sans clé : aucune lecture possible, on décrit seulement.
  console.log(`▶ Stripe ${mode.toUpperCase()} — essai à blanc SANS clé : rien n'est lu ni écrit. Avec une clé, le script retrouverait ou créerait :`);
  console.log("   · produits « Cortex Pro » et « Cortex : pack de 10 crédits »");
  for (const o of OFFERS) console.log(`   · prix ${o.nickname} — lookup_key ${o.lookupKey}`);
  console.log("   · portail client propre à Cortex (résiliation en fin de période, pas de changement d'offre)");
  console.log(`   · webhook ${site}/api/billing/webhook, et désactivation de l'ancien sur ${legacyHosts.join(", ") || "(aucun ancien hôte)"}`);
  console.log("   · puis STRIPE_WEBHOOK_SECRET et STRIPE_SECRET_KEY dans Railway");
  process.exit(0);
}

const keyRe = new RegExp(`^(sk|rk)_${mode}_`);
if (!keyRe.test(setupKey)) die(`Clé de mise en place refusée : attendu une clé ${mode} (rk_${mode}_… ou sk_${mode}_…).`);
if (runtimeKey && !keyRe.test(runtimeKey)) die(`Clé de l'app refusée : attendu une clé ${mode} (rk_${mode}_… de préférence).`);
const reused = !runtimeKey;
if (reused) runtimeKey = setupKey;

/** Pose une variable dans Railway : la valeur passe par l'entrée standard de la CLI, jamais par ses arguments. */
function railwayPut(name: string, secret: string, deploy: boolean): boolean {
  const res = spawnSync(
    "railway",
    ["variable", "set", name, "--stdin", "-p", railway.project!, "-e", railway.environment!, "-s", railway.service!, ...(deploy ? [] : ["--skip-deploys"])],
    { input: secret, stdio: ["pipe", "ignore", "ignore"] },
  );
  console.log(`   ${res.status === 0 ? "✓" : "✗"} ${name} → Railway (${railway.environment})`);
  return res.status === 0;
}

async function main(): Promise<void> {
  const stripe = new Stripe(setupKey, { apiVersion: STRIPE_API_VERSION });
  console.log(`▶ Stripe ${mode.toUpperCase()}${dryRun ? " — essai à blanc, aucune écriture" : ""} · app ${site} · API ${STRIPE_API_VERSION}`);

  // La clé de l'app est vérifiée AVANT toute écriture : posée en production sans
  // les droits de l'app (une clé limitée à la mise en place, par exemple), elle casserait l'achat.
  if (!test && !flag("--no-railway")) {
    const lacking = await missingRuntimeAccess(reused ? stripe : new Stripe(runtimeKey, { apiVersion: STRIPE_API_VERSION }));
    if (lacking.length) {
      die(`La clé de l'app${reused ? " (la clé de mise en place, réutilisée)" : ""} n'a pas accès à : ${lacking.join(", ")}. Donne-lui ces droits dans Stripe, ou saisis une clé de l'app qui les a. Rien n'a été écrit.`);
    }
    console.log("   ✓ clé de l'app — accès vérifiés (Checkout Sessions, Prices, Customer portal, Subscriptions, Invoices)");
  }

  const report = await setupStripe(stripe, { site, landing, legacyHosts, dryRun, rotateWebhook: flag("--rotate-webhook"), apiVersion: STRIPE_API_VERSION });
  for (const step of report.steps) console.log(`   ${step.action === "attention" ? "⚠" : "✓"} ${step.what} — ${step.action} : ${step.detail}`);

  if (noRailway) {
    console.log(`▶ Railway : rien n'est poussé (${dryRun ? "--dry-run" : test ? "--test" : "--no-railway"}).`);
    if (report.webhookSecret) console.log("   ⚠ Le secret du webhook vient d'être créé et n'a été posé nulle part : relancer avec --rotate-webhook pour en obtenir un nouveau.");
  } else {
    console.log("▶ Clés → Railway…");
    // Les deux changent ENSEMBLE : le webhook refuse un événement live signé pour une clé de test, et l'inverse.
    // Un seul redéploiement : la dernière variable posée le déclenche.
    if (report.webhookSecret) {
      if (!railwayPut("STRIPE_WEBHOOK_SECRET", report.webhookSecret, false)) {
        die("Le secret du webhook n'a pas pu être posé dans Railway (railway login ?). Il n'est plus récupérable : relancer avec --rotate-webhook.");
      }
    } else {
      console.log("   · STRIPE_WEBHOOK_SECRET : webhook déjà en place, son secret n'est lisible qu'à sa création — laissé tel quel (nouveau secret : --rotate-webhook)");
    }
    if (!railwayPut("STRIPE_SECRET_KEY", runtimeKey, true)) die("STRIPE_SECRET_KEY n'a pas pu être posée dans Railway (railway login ?). Relancer : le script est idempotent.");
    if (reused) console.log("   · Clé de l'app : aucune clé restreinte saisie, la clé de mise en place est réutilisée.");
  }
  console.log("OK");
}

main().catch((err: unknown) => {
  const e = err as { type?: string; code?: string; message?: string };
  die(`Stripe a refusé : ${e.type ?? "erreur"}${e.code ? ` (${e.code})` : ""} — ${e.message ?? String(err)}`);
});
