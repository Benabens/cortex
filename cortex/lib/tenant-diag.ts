import { TABLES } from "@/db/tables";
import { normalize } from "@/lib/text";

/**
 * DIAGNOSTIC D'INTÉGRITÉ DES TENANTS POSTGRES, en lecture seule (scripts/diag-tenants.ts).
 *
 * Chaque contrôle vise un défaut déjà rencontré en production ou un chemin qui peut le produire :
 * index de recherche vide d'un tenant migré (text_norm, 21/11/2026), vocabulaire absent,
 * schémas orphelins laissés par une suppression de compte, registre qui pointe un schéma disparu,
 * relevé d'index (quota des gratuits) décalé du corpus réel, suppression restée en cours.
 *
 * Tout passe par `query` avec des noms entièrement qualifiés : jamais par la façade `q`, dont la
 * moindre lecture AMORCE le tenant (CREATE SCHEMA, ligne de registre) — un diagnostic qui écrit
 * fausserait ce qu'il mesure.
 */

export type DiagQuery = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export type Severity = "erreur" | "alerte" | "info";

export type Finding = {
  severity: Severity;
  code: string;
  /** Schéma ou couple compte × cours concerné ; vide pour un constat global. */
  where: string;
  detail: string;
  /** Nombre de lignes en cause, quand il y en a. */
  count?: number;
};

export type TenantReport = {
  user: string | null;
  course: string | null;
  schema: string;
  items: number;
  sources: number;
  vocab: number;
};

export type DiagReport = { tenants: TenantReport[]; findings: Finding[] };

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const num = (v: unknown) => Number(v ?? 0) || 0;
/** Une suppression de cours prend quelques secondes ; un marqueur plus vieux est resté en plan. */
const STUCK_DELETION_MS = 60 * 60 * 1000;
/** Écart du relevé d'index toléré : au-delà, le quota d'un compte gratuit se juge sur un faux nombre. */
const INDEX_DRIFT_BYTES = 64 * 1024;

async function tableExists(query: DiagQuery, schema: string, table: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [schema, table]);
  return r.length > 0;
}

/** Lignes des tables publiques, ou [] quand la table n'existe pas encore (base neuve). */
async function publicRows(query: DiagQuery, table: string, sql: string): Promise<Record<string, unknown>[]> {
  return (await tableExists(query, "public", table)) ? query(sql) : [];
}

export async function diagnoseTenants(query: DiagQuery, opts: { now?: Date } = {}): Promise<DiagReport> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const now = opts.now ?? new Date();

  const registry = (await publicRows(query, "tenants", `SELECT user_id, course, schema_name FROM public.tenants ORDER BY user_id, course`))
    .map((r) => ({ user: String(r.user_id), course: String(r.course), schema: String(r.schema_name) }));
  const courses = new Map(
    (await publicRows(query, "courses", `SELECT id, owner_user_id FROM public.courses`)).map((r) => [String(r.id), String(r.owner_user_id)])
  );
  const schemas = new Set(
    (await query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%' ORDER BY nspname`)).map((r) => String(r.nspname))
  );
  const registered = new Set(registry.map((t) => t.schema));

  // ── registre ↔ schémas ↔ cours ──────────────────────────────────────────
  for (const t of registry) {
    const where = `${t.user} × ${t.course}`;
    if (!schemas.has(t.schema)) {
      add({ severity: "alerte", code: "registre_sans_schema", where, detail: `le registre désigne ${t.schema}, absent : le prochain accès recrée un schéma VIDE` });
    }
    const owner = courses.get(t.course);
    if (owner === undefined) {
      add({ severity: "alerte", code: "cours_inconnu", where, detail: `tenant ${t.schema} d'un cours absent de public.courses (orphelin, données gardées pour rien)` });
    } else if (owner !== t.user) {
      add({ severity: "info", code: "tenant_non_proprietaire", where, detail: `${t.schema} : le cours appartient à ${owner} ; copie que personne ne lit (seed, ancien compte)` });
    }
  }
  for (const s of schemas) {
    if (!registered.has(s)) {
      add({ severity: "alerte", code: "schema_hors_registre", where: s, detail: "schéma sans ligne dans public.tenants : prod-boot ne le migre jamais (orphelin d'une suppression ?)" });
    }
  }
  for (const [id, owner] of courses) {
    if (!registry.some((t) => t.course === id && t.user === owner)) {
      add({ severity: "info", code: "cours_sans_tenant", where: `${owner} × ${id}`, detail: "cours sans tenant : jamais ouvert ni préparé" });
    }
  }

  // ── marqueurs de suppression restés en plan ─────────────────────────────
  for (const r of await publicRows(query, "course_deletions", `SELECT user_id, course, started_at FROM public.course_deletions`)) {
    const started = Date.parse(`${String(r.started_at).replace(" ", "T")}Z`);
    if (Number.isFinite(started) && now.getTime() - started > STUCK_DELETION_MS) {
      add({ severity: "alerte", code: "suppression_bloquee", where: `${r.user_id} × ${r.course}`, detail: `suppression commencée le ${r.started_at} jamais terminée : les jobs de ce cours sont refusés` });
    }
  }

  // ── chaque tenant ───────────────────────────────────────────────────────
  const usage = new Map(
    (await publicRows(query, "index_usage", `SELECT user_id, course, bytes FROM public.index_usage`)).map((r) => [`${r.user_id}\u0000${r.course}`, num(r.bytes)])
  );
  const tenants: TenantReport[] = [];
  const bySchema = new Map(registry.map((t) => [t.schema, t]));
  for (const schema of schemas) {
    const t = bySchema.get(schema);
    const where = t ? `${t.user} × ${t.course}` : schema;
    const report: TenantReport = { user: t?.user ?? null, course: t?.course ?? null, schema, items: 0, sources: 0, vocab: 0 };
    tenants.push(report);
    const s = ident(schema);

    const cols = await query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`, [schema]);
    const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const haveTable = new Set(cols.map((c) => String(c.table_name)));
    const missing = TABLES.flatMap((spec) => spec.cols.filter((c) => !have.has(`${spec.name}.${c.name}`)).map((c) => `${spec.name}.${c.name}`));
    if (missing.length) {
      add({ severity: "info", code: "schema_en_retard", where, count: missing.length, detail: `colonnes absentes (rattrapées au prochain prod-boot si le tenant est au registre) : ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}` });
    }
    if (!haveTable.has("items") || !haveTable.has("sources")) continue;

    const c = (await query(
      `SELECT (SELECT count(*) FROM ${s}.items) items, (SELECT count(*) FROM ${s}.sources) sources,
              (SELECT count(*) FROM ${s}.items WHERE text_norm IS NULL) norm_null,
              (SELECT count(*) FROM ${s}.items i WHERE i.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${s}.sources so WHERE so.id = i.source_id)) orphans,
              (SELECT count(*) FROM ${s}.sources so WHERE NOT EXISTS (SELECT 1 FROM ${s}.items i WHERE i.source_id = so.id)) empty_sources,
              (SELECT coalesce(sum(length(text) + coalesce(length(html), 0)), 0) FROM ${s}.items) bytes`
    ))[0];
    report.items = num(c.items);
    report.sources = num(c.sources);
    report.vocab = haveTable.has("vocab") ? num((await query(`SELECT count(*) n FROM ${s}.vocab`))[0]?.n) : 0;

    if (num(c.norm_null)) {
      add({ severity: "erreur", code: "text_norm_manquant", where, count: num(c.norm_null), detail: `${num(c.norm_null)}/${report.items} passages sans text_norm : introuvables à la recherche et à l'ancrage des générations` });
    }
    if (report.items && !report.vocab) {
      add({ severity: "alerte", code: "vocabulaire_vide", where, detail: "aucun terme dans vocab : la recherche ne corrige plus les fautes de frappe" });
    }
    if (num(c.orphans)) add({ severity: "alerte", code: "passage_orphelin", where, count: num(c.orphans), detail: `${num(c.orphans)} passage(s) sans source` });
    if (num(c.empty_sources)) add({ severity: "info", code: "source_sans_passage", where, count: num(c.empty_sources), detail: `${num(c.empty_sources)} source(s) sans aucun passage (scan sans texte, document vide)` });
    if (t && courses.has(t.course) && !report.items) add({ severity: "info", code: "cours_vide", where, detail: "tenant ouvert sans aucun passage : cours visible mais jamais préparé" });

    // Ombre périmée : text_norm présent mais différent de la formule d'écriture (lib/search).
    let stale = 0;
    for (let last = 0; ;) {
      const rows = await query(`SELECT id, title, text, text_norm FROM ${s}.items WHERE text_norm IS NOT NULL AND id > $1 ORDER BY id LIMIT 1000`, [last]);
      for (const r of rows) if (r.text_norm !== normalize(`${(r.title as string | null) ?? ""} ${String(r.text ?? "")}`)) stale++;
      if (rows.length < 1000) break;
      last = num(rows[rows.length - 1].id);
    }
    if (stale) add({ severity: "alerte", code: "text_norm_perime", where, count: stale, detail: `${stale} passage(s) dont text_norm ne correspond plus au texte` });

    const idx = await query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'items_search_idx'`, [schema]);
    if (!idx.length) add({ severity: "alerte", code: "index_gin_absent", where, detail: "items_search_idx absent : recherche en parcours complet" });

    if (haveTable.has("exam_refs")) {
      const lost = num((await query(`SELECT count(*) n FROM ${s}.exam_refs r WHERE NOT EXISTS (SELECT 1 FROM ${s}.sources so WHERE so.path = r.path)`))[0]?.n);
      if (lost) add({ severity: "alerte", code: "annale_sans_source", where, count: lost, detail: `${lost} annale(s) de référence sans source indexée : le format les compte, la recherche ne les voit pas` });
    }

    if (t) {
      const declared = usage.get(`${t.user}\u0000${t.course}`);
      const real = num(c.bytes);
      if (declared !== undefined && Math.abs(declared - real) > INDEX_DRIFT_BYTES) {
        add({ severity: "alerte", code: "index_usage_decale", where, detail: `relevé d'index ${declared} o, corpus réel ${real} o : le quota d'un compte gratuit se juge sur le relevé` });
      }
    }
  }
  for (const key of usage.keys()) {
    const [user, course] = key.split("\u0000");
    if (!registry.some((t) => t.user === user && t.course === course)) {
      add({ severity: "info", code: "index_usage_sans_tenant", where: `${user} × ${course}`, detail: "relevé d'index d'un tenant disparu : compté dans le quota du compte" });
    }
  }

  const rank: Record<Severity, number> = { erreur: 0, alerte: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.where.localeCompare(b.where) || a.code.localeCompare(b.code));
  return { tenants, findings };
}

export function formatDiag(r: DiagReport): string {
  const lines: string[] = [];
  lines.push(`${r.tenants.length} schéma(s) de tenant`);
  for (const t of r.tenants) {
    lines.push(`  ${t.schema}  ${t.user ?? "(hors registre)"} × ${t.course ?? "?"}  sources=${t.sources} passages=${t.items} vocab=${t.vocab}`);
  }
  const by = (s: Severity) => r.findings.filter((f) => f.severity === s);
  lines.push("", `Constats : ${by("erreur").length} erreur(s), ${by("alerte").length} alerte(s), ${by("info").length} info(s)`);
  for (const f of r.findings) lines.push(`  [${f.severity}] ${f.code} — ${f.where} : ${f.detail}`);
  return lines.join("\n");
}
