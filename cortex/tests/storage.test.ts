/**
 * COUTURE DE STOCKAGE (lib/storage) — un même contrat, deux adaptateurs :
 *  - LocalFsStore (défaut, disque) et S3Store (seau, ici le faux seau en mémoire) ;
 *  - lecture / écriture / listage / suppression / diffusion avec plages (Range) ;
 *  - S3 : la clé est le chemin relatif au dossier de données, le dossier local
 *    n'est qu'un cache (un conteneur neuf relit tout depuis le seau) ;
 *  - withLocalDir : rapatrie, lance le moteur, renvoie ce qu'il a créé, modifié
 *    ou supprimé, même s'il échoue ; rien de ce qui n'a pas bougé n'est renvoyé ;
 *  - navigation vers un PDF → URL présignée ; HTML jamais (il garde sa CSP).
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CourseFiles } from "../lib/storage";
import { LocalFsStore } from "../lib/storage/local";
import { S3Store } from "../lib/storage/s3";
import { fakeBucket } from "./helpers/fake-bucket";

const tmps: string[] = [];
function mkTmp(prefix = "cortex-storage-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

async function text(r: Response | null): Promise<string> {
  assert.ok(r, "réponse attendue");
  return Buffer.from(await r.arrayBuffer()).toString("utf8");
}

const get = (headers: Record<string, string> = {}) => new Request("http://cortex.test/f", { headers });
const SERVE = { contentType: "text/plain; charset=utf-8", headers: { "cache-control": "private, max-age=3600" } };

type Make = () => { store: CourseFiles; root: string };
const ADAPTERS: [string, Make][] = [
  ["LocalFsStore", () => { const root = mkTmp(); return { store: new LocalFsStore(root), root }; }],
  ["S3Store", () => { const root = mkTmp(); return { store: new S3Store({ bucket: fakeBucket().bucket, root, prefix: "", presign: true }), root }; }],
];

for (const [name, make] of ADAPTERS) {
  describe(`contrat CourseFiles — ${name}`, () => {
    test("écrire puis relire ; absent → null ; un dossier n'est pas un fichier", async () => {
      const { store, root } = make();
      const f = path.join(root, "u/ben/ml/refs/final.pdf");
      assert.equal(await store.put(f, Buffer.from("%PDF-annale")), true);
      assert.equal((await store.read(f))?.toString(), "%PDF-annale");
      assert.equal((await store.stat(f))?.size, 11);
      assert.equal(await store.read(path.join(root, "u/ben/ml/refs/absent.pdf")), null);
      assert.equal(await store.stat(path.join(root, "u/ben/ml/refs")), null);
    });

    test("écriture exclusive : un fichier existant n'est pas écrasé", async () => {
      const { store, root } = make();
      const f = path.join(root, "u/ben/ml/content/notes.md");
      assert.equal(await store.put(f, "v1", { exclusive: true }), true);
      assert.equal(await store.put(f, "v2", { exclusive: true }), false);
      assert.equal((await store.read(f))?.toString(), "v1");
    });

    test("lister récursivement, mesurer, supprimer un fichier puis un dossier", async () => {
      const { store, root } = make();
      const course = path.join(root, "u/ben/ml");
      await store.put(path.join(course, "refs/a.pdf"), "aaaa");
      await store.put(path.join(course, "exams/exam-1.pdf"), "bb");
      await store.put(path.join(root, "u/ben/autre/refs/c.pdf"), "c");
      const listed = (await store.list(course)).map((e) => path.relative(course, e.path)).sort();
      assert.deepEqual(listed, ["exams/exam-1.pdf", "refs/a.pdf"]);
      assert.equal(await store.usageBytes(course), 6);
      assert.equal(await store.usageBytes(path.join(root, "u/ben")), 7);
      await store.remove(path.join(course, "refs/a.pdf"));
      assert.equal(await store.read(path.join(course, "refs/a.pdf")), null);
      await store.remove(course);
      assert.deepEqual(await store.list(course), []);
      assert.equal(await store.usageBytes(path.join(root, "u/ben")), 1, "le cours voisin reste");
      await store.remove(path.join(root, "u/ben/jamais"));
    });

    test("diffuser : 200 entier, 206 sur une plage, 416 hors du fichier, null si absent", async () => {
      const { store, root } = make();
      const f = path.join(root, "u/ben/ml/refs/notes.txt");
      await store.put(f, "0123456789");
      const full = await store.serve(f, get(), SERVE);
      assert.equal(full?.status, 200);
      assert.equal(full?.headers.get("accept-ranges"), "bytes");
      assert.equal(full?.headers.get("content-length"), "10");
      assert.equal(full?.headers.get("cache-control"), "private, max-age=3600");
      assert.equal(full?.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await text(full), "0123456789");
      const part = await store.serve(f, get({ range: "bytes=2-5" }), SERVE);
      assert.equal(part?.status, 206);
      assert.equal(part?.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(await text(part), "2345");
      const tail = await store.serve(f, get({ range: "bytes=-3" }), SERVE);
      assert.equal(await text(tail), "789");
      const out = await store.serve(f, get({ range: "bytes=50-60" }), SERVE);
      assert.equal(out?.status, 416);
      assert.equal(out?.headers.get("content-range"), "bytes */10");
      assert.equal(await store.serve(path.join(root, "u/ben/ml/refs/absent.txt"), get(), SERVE), null);
    });

    test("un chemin hors du dossier de données reste sur le disque", async () => {
      const { store } = make();
      const outside = path.join(mkTmp("cortex-repo-"), "content/cours.md");
      await store.put(outside, "contenu du dépôt");
      assert.equal(fs.readFileSync(outside, "utf8"), "contenu du dépôt");
      assert.equal((await store.read(outside))?.toString(), "contenu du dépôt");
    });

    test("withLocalDir : le moteur lit et écrit ses fichiers sur le disque", async () => {
      const { store, root } = make();
      const refs = path.join(root, "u/ben/ml/refs");
      await store.put(path.join(refs, "final.pdf"), "%PDF");
      const out = await store.withLocalDir([refs], async () => {
        const src = fs.readFileSync(path.join(refs, "final.pdf"), "utf8");
        fs.writeFileSync(path.join(refs, "final.txt"), `${src} → texte`);
        return 42;
      });
      assert.equal(out, 42);
      assert.equal((await store.read(path.join(refs, "final.txt")))?.toString(), "%PDF → texte");
    });
  });
}

describe("S3Store — le seau fait foi", () => {
  function s3(opts: { presign?: boolean; prefix?: string } = {}) {
    const fake = fakeBucket();
    const make = (root = mkTmp()) => ({ root, store: new S3Store({ bucket: fake.bucket, root, prefix: opts.prefix ?? "", presign: opts.presign ?? true }) });
    return { fake, make };
  }

  test("clé = chemin relatif au dossier de données (préfixe optionnel), type déduit de l'extension", async () => {
    const { fake, make } = s3({ prefix: "prod/" });
    const { store, root } = make();
    await store.put(path.join(root, "u/ben/ml/refs/final 2024.pdf"), "%PDF");
    assert.deepEqual([...fake.objects.keys()], ["prod/u/ben/ml/refs/final 2024.pdf"]);
    assert.equal(fake.objects.get("prod/u/ben/ml/refs/final 2024.pdf")?.contentType, "application/pdf");
  });

  test("un conteneur neuf (dossier local vide) relit tout depuis le seau", async () => {
    const { make } = s3();
    const a = make();
    await a.store.put(path.join(a.root, "u/ben/ml/exams/exam-3.pdf"), "%PDF-3");
    const b = make(); // autre conteneur : autre disque, même seau
    const f = path.join(b.root, "u/ben/ml/exams/exam-3.pdf");
    assert.equal((await b.store.read(f))?.toString(), "%PDF-3");
    assert.equal((await b.store.stat(f))?.size, 6);
    assert.deepEqual((await b.store.list(path.join(b.root, "u/ben/ml"))).map((e: { path: string }) => path.basename(e.path)), ["exam-3.pdf"]);
    assert.equal(await text(await b.store.serve(f, get({ range: "bytes=1-3" }), SERVE)), "PDF");
  });

  test("supprimer retire l'objet du seau ET la copie locale", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const f = path.join(root, "u/ben/ml/uploads/copie.png");
    await store.put(f, "png");
    await store.remove(path.join(root, "u/ben/ml"));
    assert.equal(fake.objects.size, 0);
    assert.equal(fs.existsSync(f), false);
  });

  test("navigation vers un PDF → 302 vers une URL présignée ; image, HTML et PDF embarqué : relayés", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const pdf = path.join(root, "u/ben/ml/exams/exam-1.pdf");
    await store.put(pdf, "%PDF");
    const nav = await store.serve(pdf, get({ "sec-fetch-dest": "document" }), { contentType: "application/pdf", headers: { "content-disposition": 'inline; filename="exam-1.pdf"' } });
    assert.equal(nav?.status, 302);
    const loc = new URL(nav!.headers.get("location")!);
    assert.equal(loc.host, "bucket.example.test");
    assert.equal(loc.searchParams.get("response-content-type"), "application/pdf");
    assert.equal(loc.searchParams.get("response-content-disposition"), 'inline; filename="exam-1.pdf"');
    assert.ok(Number(loc.searchParams.get("X-Amz-Expires")) <= 600, "URL de courte durée");
    // Un PDF dans une <iframe>/<embed> : la CSP (default-src 'self') bloquerait le domaine du seau.
    const embedded = await store.serve(pdf, get({ "sec-fetch-dest": "iframe" }), { contentType: "application/pdf", headers: {} });
    assert.equal(embedded?.status, 200);
    const html = path.join(root, "u/ben/ml/refs/page.html");
    await store.put(html, "<p>x</p>");
    const h = await store.serve(html, get({ "sec-fetch-dest": "document" }), { contentType: "text/html", headers: { "content-security-policy": "sandbox" } });
    assert.equal(h?.status, 200);
    assert.equal(h?.headers.get("content-security-policy"), "sandbox");
    assert.ok(!fake.calls.includes(`presign u/ben/ml/refs/page.html`));
  });

  test("I6 : une image ouverte directement (navigation) part aussi du seau ; embarquée (<img>), elle reste relayée", async () => {
    const { make } = s3();
    const { store, root } = make();
    const png = path.join(root, "u/ben/ml/uploads/capture.png");
    await store.put(png, "PNG");
    const nav = await store.serve(png, get({ "sec-fetch-dest": "document" }), { contentType: "image/png", headers: {} });
    assert.equal(nav?.status, 302);
    assert.equal(new URL(nav!.headers.get("location")!).searchParams.get("response-content-type"), "image/png");
    const img = await store.serve(png, get({ "sec-fetch-dest": "image" }), { contentType: "image/png", headers: {} });
    assert.equal(img?.status, 200, "img-src 'self' bloquerait le domaine du seau");
  });

  test("STORAGE_S3_PRESIGN=0 : même un PDF est relayé par l'app", async () => {
    const { make } = s3({ presign: false });
    const { store, root } = make();
    const pdf = path.join(root, "u/ben/ml/exams/exam-1.pdf");
    await store.put(pdf, "%PDF");
    const r = await store.serve(pdf, get({ "sec-fetch-dest": "document" }), { contentType: "application/pdf", headers: {} });
    assert.equal(r?.status, 200);
    assert.equal(await text(r), "%PDF");
  });

  test("withLocalDir sur un conteneur neuf : rapatrie, renvoie créés et modifiés, propage les suppressions", async () => {
    const { fake, make } = s3();
    const a = make();
    const course = (root: string) => path.join(root, "u/ben/ml");
    await a.store.put(path.join(course(a.root), "refs/final.pdf"), "%PDF");
    await a.store.put(path.join(course(a.root), "exams/exam-1.tex"), "v1");
    await a.store.put(path.join(course(a.root), "exams/.gen-checkpoint.json"), "{}");
    const b = make();
    const dirs = [path.join(course(b.root), "refs"), path.join(course(b.root), "exams")];
    fake.calls.length = 0;
    await b.store.withLocalDir(dirs, async () => {
      const ex = path.join(course(b.root), "exams");
      assert.equal(fs.readFileSync(path.join(course(b.root), "refs/final.pdf"), "utf8"), "%PDF", "rapatrié avant le moteur");
      fs.writeFileSync(path.join(ex, "exam-1.tex"), "v2-plus-long");
      fs.writeFileSync(path.join(ex, "exam-1.pdf"), "%PDF-1");
      fs.unlinkSync(path.join(ex, ".gen-checkpoint.json"));
    });
    assert.equal(fake.objects.get("u/ben/ml/exams/exam-1.tex")?.body.toString(), "v2-plus-long");
    assert.equal(fake.objects.get("u/ben/ml/exams/exam-1.pdf")?.body.toString(), "%PDF-1");
    assert.equal(fake.objects.has("u/ben/ml/exams/.gen-checkpoint.json"), false);
    assert.ok(!fake.calls.includes("put u/ben/ml/refs/final.pdf"), "ce qui n'a pas bougé n'est pas renvoyé");
    // Deuxième passage, rien n'a changé : aucun téléchargement, aucun envoi.
    fake.calls.length = 0;
    await b.store.withLocalDir(dirs, async () => {});
    assert.deepEqual(fake.calls.filter((c) => !c.startsWith("list ")), []);
  });

  test("withLocalDir : un moteur qui échoue laisse ses fichiers durables, l'erreur remonte", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const ex = path.join(root, "u/ben/ml/exams");
    await assert.rejects(store.withLocalDir([ex], async () => {
      fs.mkdirSync(ex, { recursive: true });
      fs.writeFileSync(path.join(ex, ".gen-checkpoint.json"), '{"batches":2}');
      throw new Error("plafond de dépense");
    }), /plafond de dépense/);
    assert.equal(fake.objects.get("u/ben/ml/exams/.gen-checkpoint.json")?.body.toString(), '{"batches":2}');
  });

  test("transit (localOnly) : l'original d'un compte gratuit n'atteint jamais le seau, même à travers un job", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const course = path.join(root, "u/ana/ml");
    const pdf = path.join(course, "refs/final-2024.pdf");
    assert.equal(await store.put(pdf, "%PDF-annale", { exclusive: true, localOnly: true }), true);
    assert.equal(await store.put(pdf, "%PDF-autre", { exclusive: true, localOnly: true }), false, "exclusif : un fichier existant n'est pas écrasé");
    assert.equal((await store.read(pdf))?.toString(), "%PDF-annale");
    assert.equal((await store.list(course)).length, 1);
    // Un job (ingestion, préparation) qui lit le fichier sans le modifier ne l'envoie pas.
    await store.withLocalDir([course], async () => {
      assert.equal(fs.readFileSync(pdf, "utf8"), "%PDF-annale");
      fs.mkdirSync(path.join(course, "exams"), { recursive: true });
      fs.writeFileSync(path.join(course, "exams/exam-1.pdf"), "%PDF-exam");
    });
    assert.deepEqual([...fake.objects.keys()], ["u/ana/ml/exams/exam-1.pdf"], "l'examen généré part au seau, jamais l'original");
    await store.remove(pdf);
    assert.equal(fs.existsSync(pdf), false);
    assert.equal(await store.read(pdf), null);
  });

  test("transit écrit PENDANT un job (envoi reçu par le serveur web) : jamais envoyé au seau à la fin du job", async () => {
    const { fake, make } = s3();
    const web = make();
    const worker = new S3Store({ bucket: fake.bucket, root: web.root, prefix: "", presign: true }); // autre process, même disque
    const course = path.join(web.root, "u/ana/ml");
    const pdf = path.join(course, "refs/final-2025.pdf");
    await worker.withLocalDir([course], async () => {
      assert.equal(await web.store.put(pdf, "%PDF-gratuit", { exclusive: true, localOnly: true }), true);
    });
    assert.deepEqual([...fake.objects.keys()], [], "l'original d'un gratuit reste hors du seau");
    // Devenu Premium : le même fichier renvoyé sans localOnly part au seau, puis suit les jobs.
    await web.store.put(pdf, "%PDF-gratuit");
    await worker.withLocalDir([course], async () => { fs.appendFileSync(pdf, "-v2"); });
    assert.equal(fake.objects.get("u/ana/ml/refs/final-2025.pdf")?.body.toString(), "%PDF-gratuit-v2");
    // Transit puis suppression : rien ne reste, ni fichier ni repère.
    const att = path.join(course, "uploads/copie.png");
    await web.store.put(att, "png", { localOnly: true });
    await web.store.remove(att);
    await worker.withLocalDir([course], async () => {});
    assert.equal(fake.objects.has("u/ana/ml/uploads/copie.png"), false);
    assert.equal(fs.existsSync(att), false);
  });

  test("transit : un nom déjà pris dans le seau n'est pas réutilisé (aucun écrasement d'un original Premium)", async () => {
    const { make } = s3();
    const a = make();
    const f = (root: string) => path.join(root, "u/ana/ml/refs/final.pdf");
    await a.store.put(f(a.root), "%PDF-cloud");
    const b = make(); // autre conteneur : le fichier n'est que dans le seau
    assert.equal(await b.store.put(f(b.root), "%PDF-transit", { exclusive: true, localOnly: true }), false);
  });

  test("withLocalDir ne pousse jamais une base SQLite ni un temporaire", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const course = path.join(root, "u/ben/ml");
    await store.withLocalDir([course], async () => {
      fs.mkdirSync(course, { recursive: true });
      fs.writeFileSync(path.join(course, "ml.db"), "sqlite");
      fs.writeFileSync(path.join(course, "ml.db-wal"), "wal");
      fs.writeFileSync(path.join(course, "notes.md"), "ok");
    });
    assert.deepEqual([...fake.objects.keys()], ["u/ben/ml/notes.md"]);
  });

  test("un fichier écrit par un worker du même conteneur, pas encore envoyé, est déjà lisible et diffusable", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const pdf = path.join(root, "u/ben/ml/exams/exam-9.pdf");
    fs.mkdirSync(path.dirname(pdf), { recursive: true });
    fs.writeFileSync(pdf, "%PDF-9"); // le worker a fini, son envoi n'est pas terminé
    assert.equal(fake.objects.size, 0);
    assert.equal((await store.stat(pdf))?.size, 6);
    assert.equal((await store.read(pdf))?.toString(), "%PDF-9");
    assert.equal((await store.list(path.dirname(pdf))).length, 1);
    const r = await store.serve(pdf, get({ "sec-fetch-dest": "document" }), { contentType: "application/pdf", headers: {} });
    assert.equal(r?.status, 200, "pas encore dans le seau : servi depuis le disque, pas d'URL présignée vers un objet absent");
    assert.equal(await text(r), "%PDF-9");
  });

  test("withLocalDir n'écrase jamais une copie locale plus récente que l'objet (worker concurrent pas encore envoyé)", async () => {
    const { make } = s3();
    const { store, root } = make();
    const dir = path.join(root, "u/ben/ml/exams");
    const ckpt = path.join(dir, ".gen-checkpoint.json");
    await store.put(ckpt, "{\"v\":1}");
    fs.writeFileSync(ckpt, "{\"v\":2,\"plus\":true}"); // le worker avance, taille différente
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(ckpt, later, later);
    await store.withLocalDir([dir], async () => {
      assert.equal(fs.readFileSync(ckpt, "utf8"), "{\"v\":2,\"plus\":true}");
    });
  });

  test("une clé du seau qui sortirait du dossier de données n'est jamais écrite sur le disque", async () => {
    const { fake, make } = s3();
    const { store, root } = make();
    const dir = path.join(root, "u/ben/ml");
    fake.objects.set("u/ben/ml/../../../evil.txt", { body: Buffer.from("x"), at: new Date() });
    await store.withLocalDir([dir], async () => {});
    assert.equal(fs.existsSync(path.join(root, "..", "evil.txt")), false);
    assert.deepEqual((await store.list(dir)).map((f) => f.path), []);
  });
});

test("configuration : aucune variable = disque local ; partielle = refus nommé ; défauts Railway Buckets", async () => {
  const { storageS3Config } = await import("../lib/storage");
  assert.equal(storageS3Config({}), null);
  assert.throws(() => storageS3Config({ STORAGE_S3_BUCKET: "b" }), /STORAGE_S3_ENDPOINT.*STORAGE_S3_ACCESS_KEY_ID.*STORAGE_S3_SECRET_ACCESS_KEY/);
  const cfg = storageS3Config({
    STORAGE_S3_BUCKET: "cortex-files-ab12", STORAGE_S3_ENDPOINT: "https://t3.storageapi.dev",
    STORAGE_S3_ACCESS_KEY_ID: "k", STORAGE_S3_SECRET_ACCESS_KEY: "s", STORAGE_S3_PREFIX: "/prod/",
  });
  assert.deepEqual(cfg, {
    bucket: "cortex-files-ab12", endpoint: "https://t3.storageapi.dev", accessKeyId: "k", secretAccessKey: "s",
    region: "auto", forcePathStyle: false, prefix: "prod/", presign: true,
  });
});

test("I15 — le seau recopié de la prod est refusé à la lecture de la config, hors production Railway (scripts lancés par railway run compris)", async () => {
  const { storageS3Config } = await import("../lib/storage");
  const prodBucket = {
    STORAGE_S3_BUCKET: "bucket-prod-ab12", STORAGE_S3_ENDPOINT: "https://t3.storageapi.dev",
    STORAGE_S3_ACCESS_KEY_ID: "k", STORAGE_S3_SECRET_ACCESS_KEY: "s",
  };
  assert.throws(() => storageS3Config({ ...prodBucket, RAILWAY_ENVIRONMENT_NAME: "cortex-pr-66" }), /STORAGE_S3_BUCKET/);
  assert.equal(storageS3Config({ ...prodBucket, RAILWAY_ENVIRONMENT_NAME: "production" })?.bucket, "bucket-prod-ab12");
});
