/**
 * MIGRATION volume → seau (lib/storage/migrate, scripts/storage-migrate.ts) :
 *  - à blanc par défaut : le plan dit quoi envoyer, le seau n'est pas touché ;
 *  - --write : envoie sous la même arborescence (clé = chemin relatif), puis
 *    vérifie les empreintes SHA-256 objet par objet ;
 *  - idempotent : relancée, elle n'envoie que ce qui manque ou diffère ;
 *  - jamais une base SQLite, le cache des pages ni un temporaire ; ne supprime rien ;
 *  - un objet altéré dans le seau est signalé par la vérification.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateToBucket, verifyBucket } from "../lib/storage/migrate";
import { fakeBucket } from "./helpers/fake-bucket";

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

function volume(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-migrate-"));
  tmps.push(root);
  const put = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put("u/ben/ml/refs/final 2024.pdf", "%PDF-final");
  put("u/ben/ml/exams/exam-1.pdf", "%PDF-exam");
  put("u/ben/ml/ml.db", "sqlite");
  put("auth.db-wal", "wal");
  put(".page-cache/u/ben/ml/refs/final-1.png", "png");
  put(".export-tmp/x-1/export.json", "{}");
  return root;
}

const quiet = { log: () => {} };

test("à blanc : le plan liste les fichiers de cours, le seau reste vide", async () => {
  const root = volume();
  const { bucket, objects } = fakeBucket();
  const r = await migrateToBucket({ bucket, root, prefix: "", write: false, ...quiet });
  assert.deepEqual(r.toUpload.sort(), ["u/ben/ml/exams/exam-1.pdf", "u/ben/ml/refs/final 2024.pdf"]);
  assert.equal(r.bytesToUpload, 19);
  assert.equal(r.uploaded, 0);
  assert.equal(objects.size, 0);
});

test("--write : mêmes clés, mêmes octets, empreintes vérifiées ; relancée, elle n'envoie rien", async () => {
  const root = volume();
  const { bucket, objects } = fakeBucket();
  const r = await migrateToBucket({ bucket, root, prefix: "prod/", write: true, ...quiet });
  assert.equal(r.uploaded, 2);
  assert.deepEqual([...objects.keys()].sort(), ["prod/u/ben/ml/exams/exam-1.pdf", "prod/u/ben/ml/refs/final 2024.pdf"]);
  assert.equal(objects.get("prod/u/ben/ml/refs/final 2024.pdf")?.body.toString(), "%PDF-final");
  assert.deepEqual(r.verify, { checked: 2, mismatched: [], missing: [] });
  const again = await migrateToBucket({ bucket, root, prefix: "prod/", write: true, ...quiet });
  assert.equal(again.uploaded, 0);
  assert.deepEqual(again.toUpload, []);
  assert.ok(fs.existsSync(path.join(root, "u/ben/ml/refs/final 2024.pdf")), "le volume n'est jamais vidé");
});

test("un fichier modifié sur le volume depuis le premier passage est renvoyé", async () => {
  const root = volume();
  const { bucket, objects } = fakeBucket();
  await migrateToBucket({ bucket, root, prefix: "", write: true, ...quiet });
  fs.writeFileSync(path.join(root, "u/ben/ml/exams/exam-1.pdf"), "%PDF-exam-v2");
  const r = await migrateToBucket({ bucket, root, prefix: "", write: true, ...quiet });
  assert.deepEqual(r.toUpload, ["u/ben/ml/exams/exam-1.pdf"]);
  assert.equal(objects.get("u/ben/ml/exams/exam-1.pdf")?.body.toString(), "%PDF-exam-v2");
});

test("vérification : un objet altéré ou absent du seau est signalé", async () => {
  const root = volume();
  const { bucket, objects } = fakeBucket();
  await migrateToBucket({ bucket, root, prefix: "", write: true, ...quiet });
  objects.get("u/ben/ml/exams/exam-1.pdf")!.body = Buffer.from("%PDF-mauv"); // même taille, autre contenu
  objects.delete("u/ben/ml/refs/final 2024.pdf");
  const v = await verifyBucket({ bucket, root, prefix: "", ...quiet });
  assert.deepEqual(v, { checked: 2, mismatched: ["u/ben/ml/exams/exam-1.pdf"], missing: ["u/ben/ml/refs/final 2024.pdf"] });
});
