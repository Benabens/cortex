/**
 * MÉTRIQUES & LOG STRUCTURÉ — process-local, zéro dépendance.
 *
 * Compteurs/histos en mémoire exposés sur /api/metrics (format Prometheus texte),
 * et un logger JSON structuré (pino-compatible dans l'esprit : niveau, temps,
 * champ `evt`, corrélation par requête/job) sans ajouter pino au bundle — les
 * routes edge et le worker partagent le même petit module.
 *
 * Clés suivies : appels LLM (par provider/modèle/issue), tokens, durées de jobs,
 * cache hit/miss. Réinitialisées au redémarrage (métriques d'instance, pas de TSDB).
 */

type Counter = Map<string, number>;
type Hist = { count: number; sum: number; min: number; max: number };

const counters: Record<string, Counter> = {};
const hists: Record<string, Map<string, Hist>> = {};

function labelKey(labels: Record<string, string | number>): string {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).sort().join(",");
}

export function inc(name: string, labels: Record<string, string | number> = {}, by = 1): void {
  (counters[name] ??= new Map());
  const k = labelKey(labels);
  counters[name].set(k, (counters[name].get(k) ?? 0) + by);
}

export function observe(name: string, value: number, labels: Record<string, string | number> = {}): void {
  (hists[name] ??= new Map());
  const k = labelKey(labels);
  const h = hists[name].get(k) ?? { count: 0, sum: 0, min: Infinity, max: -Infinity };
  h.count++; h.sum += value; h.min = Math.min(h.min, value); h.max = Math.max(h.max, value);
  hists[name].set(k, h);
}

export type MetricsSnapshot = {
  counters: Record<string, { labels: string; value: number }[]>;
  histograms: Record<string, { labels: string; count: number; sum: number; avg: number; min: number; max: number }[]>;
  uptimeSec: number;
};

const startedAt = process.hrtime.bigint();

export function snapshot(): MetricsSnapshot {
  const c: MetricsSnapshot["counters"] = {};
  for (const [name, m] of Object.entries(counters)) c[name] = [...m].map(([labels, value]) => ({ labels, value }));
  const h: MetricsSnapshot["histograms"] = {};
  for (const [name, m] of Object.entries(hists)) {
    h[name] = [...m].map(([labels, x]) => ({ labels, count: x.count, sum: Math.round(x.sum), avg: Math.round(x.sum / x.count), min: x.min === Infinity ? 0 : Math.round(x.min), max: x.max === -Infinity ? 0 : Math.round(x.max) }));
  }
  return { counters: c, histograms: h, uptimeSec: Number(process.hrtime.bigint() - startedAt) / 1e9 };
}

/** Rendu Prometheus texte (exposition /api/metrics). */
export function renderPrometheus(): string {
  const lines: string[] = [];
  const snap = snapshot();
  const fmtLabels = (labels: string) => labels ? `{${labels.split(",").map((p) => { const [k, ...v] = p.split("="); return `${k}="${v.join("=")}"`; }).join(",")}}` : "";
  for (const [name, rows] of Object.entries(snap.counters)) {
    lines.push(`# TYPE ${name} counter`);
    for (const r of rows) lines.push(`${name}${fmtLabels(r.labels)} ${r.value}`);
  }
  for (const [name, rows] of Object.entries(snap.histograms)) {
    lines.push(`# TYPE ${name} summary`);
    for (const r of rows) {
      lines.push(`${name}_count${fmtLabels(r.labels)} ${r.count}`);
      lines.push(`${name}_sum${fmtLabels(r.labels)} ${r.sum}`);
    }
  }
  lines.push(`# TYPE cortex_uptime_seconds gauge`);
  lines.push(`cortex_uptime_seconds ${Math.round(snap.uptimeSec)}`);
  return lines.join("\n") + "\n";
}

// ─────────────────────── Log structuré ───────────────────────

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
function threshold(): number {
  return LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;
}

/** Log JSON une ligne (ou humain si LOG_PRETTY=1). `evt` = nom d'événement machine. */
export function log(level: Level, evt: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold()) return;
  const rec = { level, evt, time: new Date().toISOString(), ...fields };
  const line = process.env.LOG_PRETTY === "1"
    ? `[${level}] ${evt} ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`
    : JSON.stringify(rec);
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}
