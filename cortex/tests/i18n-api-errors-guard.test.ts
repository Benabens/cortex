/**
 * Garde-fou : plus aucune route ne fabrique une erreur à la main (phrase sans code, dans
 * une seule langue) ; toutes passent par apiError (lib/i18n/api-error).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(__dirname, "..");
function routeFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(rel) : rel.endsWith(".ts") ? [rel] : [];
  });
}

/** Une erreur fabriquée à la main : objet de réponse qui commence par `error:`, ou champ `error`
 *  rempli par une phrase littérale (y compris au bout d'un objet ou d'un ternaire). */
const HANDMADE = [
  /\b(NextResponse|Response)\.json\(\s*\{\s*(\.\.\.[\w.]+,\s*)?error\s*:/,
  /\berror\s*:\s*(["'`]|[^,}\n]*\?[^,}\n]*["'`])/,
];

function offendersIn(f: string, src: string): string[] {
  return src.split("\n").flatMap((line, i) => HANDMADE.some((re) => re.test(line)) ? [`${f}:${i + 1}  ${line.trim().slice(0, 100)}`] : []);
}

test("garde-fou : il reconnaît les formes déjà vues (champ en tête, en fin d'objet, ternaire, multiligne)", () => {
  const sample = [
    `return NextResponse.json({ error: "Cours introuvable." }, { status: 404 });`,
    `{ ok, file, recompiled: true, error: ok ? null : "Le PDF ne compile toujours pas." },`,
    "      { error: `Confirmation manquante : tape « ${WORD} »` },",
    `constructor(error: UserError | UserError["code"], status: number) {`,
    `return apiError(req, "pdf_recompile_failed", 500, view);`,
  ].join("\n");
  assert.deepEqual(offendersIn("x.ts", sample).map((o) => o.split("  ")[0]), ["x.ts:1", "x.ts:2", "x.ts:3"]);
});

test("garde-fou : aucune route ne renvoie une erreur sans code (toutes passent par apiError)", () => {
  const files = [...routeFiles("app/api"), "proxy.ts", "lib/req.ts", "lib/upload-limit.ts"];
  const offenders = files.flatMap((f) => offendersIn(f, fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, []);
});

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === "node_modules" ? [] : sourceFiles(rel)) : /\.tsx?$/.test(rel) ? [rel] : [];
  });
}

test("chaque code d'erreur du dictionnaire est renvoyé quelque part (pas de code mort ni mal recopié)", () => {
  const fr = JSON.parse(fs.readFileSync(path.join(ROOT, "messages/fr.json"), "utf8")) as { errors: Record<string, string> };
  const src = ["app", "lib", "db", "components"].flatMap(sourceFiles).concat("proxy.ts").map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const unused = Object.keys(fr.errors).filter((k) => !new RegExp(`["'\`]${k}["'\`]`).test(src));
  assert.deepEqual(unused, []);
});
