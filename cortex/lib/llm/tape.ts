import crypto from "node:crypto";
import fs from "node:fs";
import { cacheKey } from "./cache";
import { LlmError, type CompleteRequest, type CompleteResult } from "./types";

/**
 * BANDE LLM DU BANC (scripts/bench) — `LLM_TAPE=record:<fichier>` ajoute chaque réponse
 * du modèle au fichier (JSONL) ; `LLM_TAPE=replay:<fichier>` les rejoue sans appeler
 * aucun fournisseur. Hors banc, la variable n'est pas posée : aucun effet.
 *
 * Rejeu : par empreinte de la requête (même prompt, même modèle, même schéma), sinon par
 * RANG au même site d'appel — un prompt retouché depuis l'enregistrement reçoit la réponse
 * de même forme, le moteur reste exercé de bout en bout. Chaque rejeu est noté dans
 * `<fichier>.replay.jsonl` (exact / rank) : le banc dit combien de réponses sont approchées.
 * Un site jamais enregistré échoue (UNAVAILABLE) : un rejeu n'invente rien.
 */

type Mode = { mode: "record" | "replay"; file: string };

type Entry = {
  key: string;
  site: string;
  rank: number;
  model: string;
  promptChars: number;
  systemChars: number;
  outputChars: number;
  ms: number;
  /** Empreinte du prompt système : le banc estime le cache de prompt de l'API (même préfixe, 5 min). */
  systemHash?: string;
  /** Redemande de completeJson après une réponse illisible. */
  jsonRetry?: boolean;
  at: number;
  text?: string;
  provider?: string;
  usage?: CompleteResult["usage"];
  error?: { code?: string; message: string };
};

export function tapeMode(): Mode | null {
  const raw = (process.env.LLM_TAPE ?? "").trim();
  const m = /^(record|replay):(.+)$/.exec(raw);
  if (!raw) return null;
  if (!m) throw new Error(`LLM_TAPE invalide : « ${raw} » (attendu : record:<fichier> ou replay:<fichier>)`);
  return { mode: m[1] as Mode["mode"], file: m[2] };
}

/** Rang de l'appel à son site, par fichier de bande (un nouveau fichier repart de 0). */
const ranks = new Map<string, number>();
export function nextRank(file: string, site: string): number {
  const k = `${file}\u0000${site}`;
  const r = ranks.get(k) ?? 0;
  ranks.set(k, r + 1);
  return r;
}

export function tapeKey(req: CompleteRequest): string {
  return cacheKey("tape", req);
}

export function recordCall(t: Mode, req: CompleteRequest, site: string, rank: number, ms: number, out: { result?: CompleteResult; error?: unknown }): void {
  const e = out.error;
  const entry: Entry = {
    key: tapeKey(req), site, rank, model: String(req.model ?? "opus"),
    promptChars: req.prompt.length, systemChars: req.system?.length ?? 0, outputChars: out.result?.text.length ?? 0, ms,
    ...(req.system ? { systemHash: crypto.createHash("sha256").update(req.system).digest("hex").slice(0, 16) } : {}),
    ...(/\nATTENTION \(essai \d+\/\d+\)/.test(req.prompt) ? { jsonRetry: true } : {}),
    at: Date.now() - ms,
    ...(out.result ? { text: out.result.text, provider: out.result.provider, usage: out.result.usage } : {}),
    ...(e ? { error: { code: e instanceof LlmError ? e.code : undefined, message: e instanceof Error ? e.message : String(e) } } : {}),
  };
  fs.appendFileSync(t.file, `${JSON.stringify(entry)}\n`);
}

const loaded = new Map<string, { byKey: Map<string, Entry[]>; bySite: Map<string, Entry[]> }>();
function load(file: string): { byKey: Map<string, Entry[]>; bySite: Map<string, Entry[]> } {
  let t = loaded.get(file);
  if (t) return t;
  t = { byKey: new Map(), bySite: new Map() };
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  for (const line of lines) {
    const e = JSON.parse(line) as Entry;
    t.byKey.set(e.key, [...(t.byKey.get(e.key) ?? []), e]);
    t.bySite.set(e.site, [...(t.bySite.get(e.site) ?? []), e]);
  }
  for (const list of t.bySite.values()) list.sort((a, b) => a.rank - b.rank);
  loaded.set(file, t);
  return t;
}

/** Réponse rejouée (ou erreur rejouée) ; LlmError UNAVAILABLE si la bande n'a rien pour ce site. */
export function replayCall(t: Mode, req: CompleteRequest, site: string, rank: number): CompleteResult {
  const tape = load(t.file);
  // Un même prompt peut revenir plusieurs fois (réessai à l'identique) : servi dans l'ordre.
  const same = tape.byKey.get(tapeKey(req)) ?? [];
  const exact = same.find((e) => e.site === site && e.rank === rank) ?? same.find((e) => e.site === site) ?? same[0];
  const bySite = tape.bySite.get(site) ?? [];
  const hit = exact ?? bySite.find((e) => e.rank === rank) ?? bySite[rank % Math.max(1, bySite.length)];
  if (!hit) throw new LlmError(`Bande du banc : aucun enregistrement pour le site « ${site} » (rang ${rank}) — réenregistre la bande.`, "UNAVAILABLE");
  fs.appendFileSync(`${t.file}.replay.jsonl`, `${JSON.stringify({ site, rank, match: exact ? "exact" : "rank" })}\n`);
  if (hit.error) throw new LlmError(hit.error.message, hit.error.code);
  return { text: hit.text ?? "", provider: hit.provider ?? "tape", model: hit.model, usage: hit.usage };
}
