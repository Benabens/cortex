import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Metrics } from "./metrics";
import type { Verdict } from "./thresholds";
import type { BenchRun, Verdicts } from "./types";

/**
 * RAPPORT DU BANC — un tableau par cas (référence → actuel, seuil, vert/rouge), et
 * l'échantillon de CALIBRAGE : 10 % des questions d'un run, tirées de façon reproductible,
 * à noter à la main (calibration.md) ; les verdicts du juge sur ces mêmes questions sont à
 * part (calibration-juge.json) pour comparer après coup sans être influencé.
 */

type Scored = { case: string; commit: string; provider?: string; metrics: Metrics; thresholds: Verdict[]; dir: string };

/** Questions de l'échantillon : ≈ 10 % (au moins 1), tirées par empreinte du run (même run → même tirage). */
export function calibrationPick(run: BenchRun): number[] {
  const items = run.exam?.items ?? [];
  const n = Math.max(1, Math.round(items.length / 10));
  const seeded = (i: number) => crypto.createHash("sha256").update(`${run.caseId}|${run.startedAt}|${i}`).digest("hex");
  return items.map((it) => it.idx).sort((a, b) => seeded(a).localeCompare(seeded(b))).slice(0, n).sort((a, b) => a - b);
}

export function calibrationSample(run: BenchRun, verdicts: Verdicts): { markdown: string; judged: Verdicts["items"] } {
  const pick = new Set(calibrationPick(run));
  const L = "ABCDEFGH";
  const blocks = (run.exam?.items ?? []).filter((it) => pick.has(it.idx)).map((it) => {
    const opts = it.options ? it.options.map((o, k) => `- ${L[k]}) ${o}`).join("\n") : "";
    const key = it.options ? `**Clé** : ${(it.correct ?? []).map((k) => L[k]).join(", ")}\n\n**Explication** : ${it.explanation ?? ""}` : `**Corrigé** : ${(it.solution ?? "").slice(0, 3000)}`;
    return [`## Q${it.idx}`, it.stem, opts, key, "",
      "- [ ] clé juste   - [ ] clé fausse   - [ ] incertain",
      "- [ ] explication cohérente avec la clé",
      "- distracteurs triviaux (lettres) : ",
      "- hors cours : oui / non",
      "- remarque : ", ""].join("\n\n");
  });
  const judged = verdicts.items.filter((v) => pick.has(v.idx));
  const markdown = [`# Calibrage du juge — ${run.caseId} (${run.commit})`, "", `${pick.size} question(s) sur ${run.exam?.items.length ?? 0}, tirées au hasard reproductible. Note-les sans regarder calibration-juge.json.`, "", ...blocks].join("\n");
  return { markdown, judged };
}

function latestRun(caseDir: string, label?: string): string | null {
  if (!fs.existsSync(caseDir)) return null;
  const dirs = fs.readdirSync(caseDir).filter((d) => fs.existsSync(path.join(caseDir, d, "metrics.json"))).sort();
  const pick = label ? dirs.filter((d) => fs.existsSync(path.join(caseDir, d, label))) : dirs;
  return pick.length ? path.join(caseDir, pick[pick.length - 1]) : null;
}

function load(dir: string | null): Scored | null {
  if (!dir) return null;
  const m = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8")) as Omit<Scored, "dir">;
  return { ...m, dir };
}

/**
 * Tableau référence → actuel de tous les cas sous `<home>/runs`. Référence : le dernier run
 * marqué REFERENCE (fichier vide posé par `bench mark-ref`) ; actuel : le dernier run.
 */
export function writeReport(home: string, out?: string): string {
  const runs = path.join(home, "runs");
  const cases = fs.existsSync(runs) ? fs.readdirSync(runs).sort() : [];
  const lines: string[] = [`# Banc moteur — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ""];
  const red: string[] = [];
  for (const c of cases) {
    const ref = load(latestRun(path.join(runs, c), "REFERENCE"));
    const cur = load(latestRun(path.join(runs, c)));
    if (!cur) continue;
    lines.push(`## ${c}`, "", `Référence : ${ref ? `${ref.commit} (${ref.provider ?? "provider inconnu"})` : "—"} · actuel : ${cur.commit} (${cur.provider ?? "provider inconnu"})`, "", "| Métrique | Référence | Actuel | Seuil | |", "|---|---|---|---|---|");
    for (const v of cur.thresholds) {
      const r = ref?.thresholds.find((x) => x.id === v.id);
      lines.push(`| ${v.label} | ${r?.value ?? "—"} | ${v.value} | ${v.limit} | ${v.pass === null ? "·" : v.pass ? "✅" : "❌"} |`);
      if (v.pass === false) red.push(`${c} : ${v.label} (${v.value}, seuil ${v.limit})`);
    }
    const p = cur.metrics.perf;
    lines.push("", `Perf (${cur.provider ?? "provider inconnu"}, propre au banc et non représentative de la production) : ${Math.round(p.totalMs / 1000)} s, ${p.calls} appels, ${p.jsonRetries} redemandes JSON, ${p.topupBatches} lots de comblement, ${p.dedupReplacements} remplacements de doublons. Coût de production estimé (non mesuré, non facturé par ce run) : ${p.tokensIn} tokens en entrée, ${p.tokensOut} en sortie, cache ${Math.round(p.cacheRate * 100)} %, ${p.costUsd.toFixed(3)} $.`, "");
  }
  lines.push("## Reste rouge", "", ...(red.length ? red.map((r) => `- ${r}`) : ["- rien"]), "");
  const text = lines.join("\n");
  if (out) fs.writeFileSync(out, text);
  return text;
}
