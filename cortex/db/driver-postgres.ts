import { AsyncLocalStorage } from "node:async_hooks";
import { currentUser, tenantSchema } from "./context";
import { currentCourse } from "./client";
import { registerDriver, type QueryDriver, type RunResult, type SqlParam } from "./q";
import { allDdl } from "./tables";

/**
 * Driver Postgres de la façade q (voie « production », DB_DRIVER=postgres).
 *
 * MULTI-TENANT PAR SCHÉMA : chaque (utilisateur, cours) a son schéma PG
 * `t_<user>_<cours>` (cf. db/context.ts). L'isolation est structurelle : le
 * search_path de la connexion détermine seul les tables visibles — le SQL
 * applicatif (portable, placeholders `?`) est identique au mode SQLite.
 *
 * DEUX BACKENDS, choisis par DATABASE_URL :
 *  - postgres://…  → postgres.js, un POOL PAR TENANT (search_path fixé à la
 *    connexion — symétrique du cache « une connexion SQLite par cours »).
 *  - pglite://<dir> ou pglite://memory → PGlite (Postgres WASM in-process) :
 *    zéro Docker, pour les tests (isolation multi-tenant prouvable en CI) et
 *    la démo locale. Connexion unique sérialisée + SET search_path par tenant.
 */

type PgRows = Record<string, unknown>[];

interface TenantExec {
  /** Exécute une requête $1-paramétrée dans le schéma du tenant. */
  query(text: string, params: SqlParam[]): Promise<{ rows: PgRows; count: number }>;
  /** Exécute du DDL/multi-statements dans le schéma du tenant. */
  exec(text: string): Promise<void>;
  /** Transaction : tout callback exécuté sur la MÊME connexion, BEGIN/COMMIT géré. */
  begin<T>(fn: (tx: TenantExec) => Promise<T>): Promise<T>;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DB_DRIVER=postgres exige DATABASE_URL (postgres://… ou pglite://<dossier>|pglite://memory)."
    );
  }
  return url;
}

/** Traduit les placeholders `?` en `$1…$n` (hors chaînes '…' et identifiants "…"). */
export function toDollarParams(sql: string): string {
  let out = "";
  let n = 0;
  let inS = false;
  let inD = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inS) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i++; } else inS = false;
      }
    } else if (inD) {
      out += ch;
      if (ch === '"') inD = false;
    } else if (ch === "'") {
      inS = true; out += ch;
    } else if (ch === '"') {
      inD = true; out += ch;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// ─────────────────────────── backend postgres.js ───────────────────────────

type PostgresSql = import("postgres").Sql;

let _basePostgres: typeof import("postgres") | null = null;
function postgresLib(): typeof import("postgres") {
  if (!_basePostgres) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _basePostgres = require("postgres");
  }
  return _basePostgres!;
}

const pgPools = new Map<string, PostgresSql>();
const bootstrapped = new Set<string>();

/** Nombre max de pools tenant gardés vivants (1 pool = jusqu'à PG_POOL_MAX
 *  connexions). Au-delà, le plus anciennement utilisé est fermé : sans cette
 *  borne, un balayage périodique de N tenants ouvrirait N pools et épuiserait
 *  `max_connections` du Postgres managé. */
function maxPools(): number {
  const n = Number(process.env.PG_MAX_TENANT_POOLS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

function poolFor(schema: string): PostgresSql {
  let pool = pgPools.get(schema);
  if (!pool) {
    const postgres = postgresLib();
    pool = postgres(databaseUrl(), {
      max: Math.max(1, Number(process.env.PG_POOL_MAX) || 3),
      connection: { search_path: `"${schema}"` },
      onnotice: () => {},
      idle_timeout: 30,
    });
    pgPools.set(schema, pool);
    // Éviction LRU (Map = ordre d'insertion) au-delà du plafond. On NE retire
    // PAS le schéma de `bootstrapped` : le DDL a bien été appliqué et il le
    // reste — le rejouer à chaque va-et-vient rendrait un balayage périodique
    // très coûteux. `end({timeout})` laisse les requêtes en vol se terminer.
    while (pgPools.size > maxPools()) {
      const oldest = pgPools.keys().next().value as string | undefined;
      if (!oldest || oldest === schema) break;
      const victim = pgPools.get(oldest);
      pgPools.delete(oldest);
      try { void victim?.end({ timeout: 30 }); } catch { /* fermeture best-effort */ }
    }
  } else {
    // Rafraîchit la position LRU.
    pgPools.delete(schema);
    pgPools.set(schema, pool);
  }
  return pool;
}

/**
 * Postgres REJETTE les octets NUL (\u0000) et les surrogates UTF-16 isolés dans
 * les text (« invalid byte sequence for encoding UTF8 ») — sqlite les tolère,
 * et les textes extraits de PDF en contiennent. Assainissement au niveau du
 * driver : TOUT chemin d'écriture est couvert (ingest, jobs, uploads…), même
 * recette que scripts/migrate-to-postgres.ts (perte limitée aux octets invalides).
 */
export function pgSafeParams<T>(params: T[]): T[] {
  let changed = false;
  const out = params.map((v) => {
    if (typeof v !== "string") return v;
    const clean = (v.includes("\u0000") ? v.replaceAll("\u0000", "") : v).toWellFormed();
    if (clean !== v) changed = true;
    return clean as unknown as T;
  });
  return changed ? out : params;
}

function postgresJsExec(schema: string): TenantExec {
  const pool = poolFor(schema);
  const wrap = (sql: PostgresSql): TenantExec => ({
    async query(text, params) {
      const r = await sql.unsafe(text, pgSafeParams(params) as never[]);
      return { rows: r as unknown as PgRows, count: r.count ?? (Array.isArray(r) ? r.length : 0) };
    },
    async exec(text) {
      await sql.unsafe(text).simple();
    },
    async begin(fn) {
      return sql.begin(async (tsql) => fn(wrap(tsql as unknown as PostgresSql))) as Promise<never>;
    },
  });
  return wrap(pool);
}

// ─────────────────────────── backend PGlite ───────────────────────────

type PGliteInstance = {
  query(text: string, params?: unknown[]): Promise<{ rows: PgRows; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query(text: string, params?: unknown[]): Promise<{ rows: PgRows; affectedRows?: number }> }) => Promise<T>): Promise<T>;
};

let _pglite: PGliteInstance | null = null;
let _pgliteChain: Promise<unknown> = Promise.resolve();
let _pgliteSchema: string | null = null;

async function pgliteInstance(): Promise<PGliteInstance> {
  if (!_pglite) {
    const target = databaseUrl().replace(/^pglite:\/\//, "");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
    _pglite = new PGlite(target === "memory" ? undefined : target) as unknown as PGliteInstance;
  }
  return _pglite;
}

/** PGlite = une seule connexion → tout passe par une file FIFO + SET search_path. */
function pgliteSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = _pgliteChain.then(fn, fn);
  _pgliteChain = next.then(() => undefined, () => undefined);
  return next as Promise<T>;
}

function pgliteExec(schema: string): TenantExec {
  const setPath = async (db: PGliteInstance) => {
    if (_pgliteSchema !== schema) {
      await db.exec(`SET search_path TO "${schema}"`);
      _pgliteSchema = schema;
    }
  };
  return {
    query(text, params) {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        const r = await db.query(text, pgSafeParams(params) as unknown[]);
        return { rows: r.rows, count: r.affectedRows ?? r.rows.length };
      });
    },
    exec(text) {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        await db.exec(text);
      });
    },
    begin<T>(fn: (tx: TenantExec) => Promise<T>): Promise<T> {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        return db.transaction(async (tx) => {
          const txExec: TenantExec = {
            async query(text, params) {
              const r = await tx.query(text, pgSafeParams(params) as unknown[]);
              return { rows: r.rows, count: r.affectedRows ?? r.rows.length };
            },
            async exec(text) {
              await tx.query(text);
            },
            begin() {
              throw new Error("PGlite : transaction imbriquée non supportée");
            },
          };
          return fn(txExec);
        });
      });
    },
  };
}

// ─────────────────────────── bootstrap tenant + driver ───────────────────────────

function isPglite(): boolean {
  return databaseUrl().startsWith("pglite://");
}

function rawExec(schema: string): TenantExec {
  return isPglite() ? pgliteExec(schema) : postgresJsExec(schema);
}

/**
 * HYDRATATION des nouveaux tenants (opt-in SEED_NEW_TENANTS=1) :
 * un user fraîchement inscrit reçoit une COPIE SQL du contenu de COURS du
 * tenant de seed (owner, hydraté par prod-boot) — sources/items/vocab/annales/
 * programme/banque de révision/ADN — jamais les données PERSONNELLES
 * (faiblesses, planning, examens générés, jobs). Sans quoi un nouveau compte
 * a un tenant vide et ne peut rien générer. Idempotent (cible non vide → no-op).
 */
const SEED_CONTENT_TABLES = [
  "sources", "items", "vocab", "exam_refs", "topics", "plan_chapters",
  "bank_questions", "revision_plan", "format_profile", "exam_dna", "exam_exercises",
];

async function hydrateFromSeedTenant(ex: TenantExec, schema: string): Promise<void> {
  if (process.env.SEED_NEW_TENANTS !== "1") return;
  const seedUser = process.env.CORTEX_SEED_USER || "owner";
  if (currentUser() === seedUser) return;
  const seedSchema = await resolveTenantSchema(seedUser, currentCourse());
  if (seedSchema === schema) return;
  const target = await ex.query(`SELECT count(*) n FROM items`, []);
  if (Number((target.rows[0] as { n?: number | string })?.n ?? 0) > 0) return; // déjà peuplé
  const seedThere = await ex.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [seedSchema],
  );
  if (!seedThere.rows.length) return; // pas de seed pour ce cours
  for (const t of SEED_CONTENT_TABLES) {
    try {
      // Copie par NOMS DE COLONNES (jamais `SELECT *` : un ordre de colonnes
      // qui diverge entre les deux schémas — après l'ajout d'une colonne au
      // milieu de la spec — décalerait silencieusement les données).
      const cols = await ex.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND column_name IN (SELECT column_name FROM information_schema.columns
                               WHERE table_schema = $3 AND table_name = $2)
         ORDER BY ordinal_position`,
        [seedSchema, t, schema],
      );
      const names = cols.rows.map((r) => `"${(r as { column_name: string }).column_name}"`);
      if (!names.length) continue;
      const list = names.join(", ");
      await ex.exec(`INSERT INTO "${schema}".${t} (${list}) SELECT ${list} FROM "${seedSchema}".${t}`);
    } catch (e) {
      // Contenu partiel plutôt que crash — mais on TRACE (un échec silencieux
      // donnerait un tenant à moitié hydraté sans aucun diagnostic).
      // eslint-disable-next-line no-console
      console.warn(`[tenant] hydratation ${t} → ${schema} échouée :`, (e as Error)?.message?.slice(0, 200));
    }
  }
  // Les ids copiés sont explicites → resynchronise les séquences identity.
  for (const t of SEED_CONTENT_TABLES) {
    try {
      await ex.exec(
        `SELECT setval(pg_get_serial_sequence('"${schema}".${t}', 'id'), (SELECT coalesce(max(id), 1) FROM "${schema}".${t}))`
      );
    } catch { /* pas de colonne id auto */ }
  }
}

/**
 * NOM DE SCHÉMA d'un tenant : celui ENREGISTRÉ dans public.tenants fait foi et
 * n'est jamais réécrit — la règle de nommage (tenantSchema) ne s'applique
 * qu'aux tenants nouveaux. Sans cela, un changement de règle (identifiants
 * longs désormais suffixés) créerait un schéma vide à côté des données.
 */
const schemaByTenant = new Map<string, string>();
type RegistryLookup = (userId: string, courseId: string) => Promise<string | null>;
const defaultRegistryLookup: RegistryLookup = async (userId, courseId) => {
  const r = await rawExec("public").query(
    `SELECT schema_name FROM public.tenants WHERE user_id = $1 AND course = $2`, [userId, courseId],
  );
  const registered = (r.rows[0] as { schema_name?: string } | undefined)?.schema_name;
  return registered ? String(registered) : null;
};
let registryLookup: RegistryLookup = defaultRegistryLookup;
/** (tests) remplace la lecture du registre pour simuler une panne. */
export function setTenantRegistryLookupForTests(fn: RegistryLookup | null): void {
  registryLookup = fn ?? defaultRegistryLookup;
  schemaByTenant.clear();
}
export async function resolveTenantSchema(userId: string, courseId: string): Promise<string> {
  const key = `${userId}\u0000${courseId}`;
  const cached = schemaByTenant.get(key);
  if (cached) return cached;
  let name = tenantSchema(userId, courseId);
  try {
    const registered = await registryLookup(userId, courseId);
    if (registered) name = registered;
  } catch (e) {
    // Seule la table ABSENTE (42P01 : base neuve, avant la première DDL) vaut
    // « aucun nom enregistré ». Toute autre panne (pool, timeout, réseau) fait
    // échouer la requête : on ne crée jamais un schéma vide à côté des données,
    // et rien n'est mis en cache — le prochain accès relira le registre.
    if ((e as { code?: string } | null)?.code !== "42P01") throw e;
  }
  schemaByTenant.set(key, name);
  return name;
}

/** Oublie un tenant (schéma supprimé) : le prochain accès repart du registre. */
export function forgetTenant(userId: string, courseId: string): void {
  const key = `${userId}\u0000${courseId}`;
  const name = schemaByTenant.get(key);
  schemaByTenant.delete(key);
  if (name) bootstrapped.delete(name);
}

/** CREATE SCHEMA + schéma applicatif complet, une fois par tenant et par process. */
async function ensureTenant(schema: string): Promise<TenantExec> {
  const ex = rawExec(schema);
  if (!bootstrapped.has(schema)) {
    await ex.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // PGlite : le SET search_path a pu précéder la création → re-force.
    if (isPglite()) _pgliteSchema = null;
    for (const stmt of allDdl("postgres")) await ex.exec(stmt);
    // Recherche plein-texte : équivalent PG de fts_items (cf. lib/search.ts).
    await ex.exec(
      `CREATE INDEX IF NOT EXISTS items_search_idx ON items USING GIN (to_tsvector('simple', coalesce(text_norm, '')))`
    );
    // Registre GLOBAL des tenants (schéma public) : permet au boot de prod de
    // re-migrer/réconcilier tous les tenants connus (le nom de schéma seul ne
    // suffit pas — pgIdent tronque user/cours). Best-effort : jamais bloquant.
    try {
      await ex.exec(
        `CREATE TABLE IF NOT EXISTS public.tenants (
          user_id text NOT NULL, course text NOT NULL,
          schema_name text NOT NULL, last_seen text NOT NULL,
          PRIMARY KEY (user_id, course))`
      );
      await ex.query(
        `INSERT INTO public.tenants (user_id, course, schema_name, last_seen) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, course) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
        [currentUser(), currentCourse(), schema, new Date().toISOString().slice(0, 19).replace("T", " ")]
      );
    } catch {
      // registre indisponible (ex. course/context hors chaîne) — le tenant reste fonctionnel
    }
    try { await hydrateFromSeedTenant(ex, schema); } catch { /* best-effort */ }
    bootstrapped.add(schema);
  }
  return ex;
}

/** Transaction en cours de la chaîne async courante (routage des q.* internes). */
const txCtx = new AsyncLocalStorage<TenantExec>();

async function executor(): Promise<TenantExec> {
  const tx = txCtx.getStore();
  if (tx) return tx;
  return ensureTenant(await resolveTenantSchema(currentUser(), currentCourse()));
}

const postgresDriver: QueryDriver = {
  dialect: "postgres",

  async all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
    const ex = await executor();
    return (await ex.query(toDollarParams(sql), params)).rows as T[];
  },

  async get<T>(sql: string, params: SqlParam[]): Promise<T | undefined> {
    const ex = await executor();
    return (await ex.query(toDollarParams(sql), params)).rows[0] as T | undefined;
  },

  async run(sql: string, params: SqlParam[]): Promise<RunResult> {
    const ex = await executor();
    const r = await ex.query(toDollarParams(sql), params);
    return { changes: r.count, lastInsertRowid: Number((r.rows[0] as { id?: number })?.id ?? 0) };
  },

  async insert(sql: string, params: SqlParam[]): Promise<number> {
    const ex = await executor();
    const withReturning = /returning\s/i.test(sql) ? sql : `${sql.replace(/;\s*$/, "")} RETURNING id`;
    const r = await ex.query(toDollarParams(withReturning), params);
    const id = (r.rows[0] as { id?: number })?.id;
    if (typeof id !== "number") throw new Error("INSERT sans id retourné (table sans colonne id ?)");
    return id;
  },

  async exec(sql: string): Promise<void> {
    const ex = await executor();
    await ex.exec(sql);
  },

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (txCtx.getStore()) return fn(); // tx imbriquée → aplatie (même sémantique que le driver sqlite)
    const ex = await executor();
    return ex.begin((tex) => txCtx.run(tex, fn));
  },

  async columns(table: string): Promise<string[]> {
    const ex = await executor();
    const r = await ex.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [await resolveTenantSchema(currentUser(), currentCourse()), table]
    );
    return r.rows.map((row) => String((row as { column_name: string }).column_name));
  },

  async addColumn(table: string, colDdl: string): Promise<void> {
    const ex = await executor();
    await ex.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${colDdl}`);
  },
};

registerDriver(postgresDriver);

export { postgresDriver };

/**
 * Transaction PGlite sur le schéma `public` (store d'auth). Sérialisée avec le
 * reste de la file : rien ne peut s'intercaler entre ses requêtes — c'est ce
 * qui rend la réservation de crédits atomique aussi sur ce backend.
 */
export async function pglitePublicTransaction<T>(
  fn: (query: (text: string, params: SqlParam[]) => Promise<PgRows>) => Promise<T>,
): Promise<T> {
  return pgliteSerial(async () => {
    const db = await pgliteInstance();
    await db.exec(`SET search_path TO public`);
    _pgliteSchema = null;
    return db.transaction(async (tx) => fn(async (text, params) => (await tx.query(text, pgSafeParams(params) as unknown[])).rows));
  });
}

/** Requête PGlite sur le schéma `public` (store d'auth) — sérialisée avec le reste. */
export async function pglitePublicQuery(text: string, params: SqlParam[]): Promise<PgRows> {
  return pgliteSerial(async () => {
    const db = await pgliteInstance();
    await db.exec(`SET search_path TO public`);
    _pgliteSchema = null; // le prochain appel tenant re-forcera son schéma
    const r = await db.query(text, pgSafeParams(params) as unknown[]);
    return r.rows;
  });
}

/** Ferme les pools (tests / arrêt propre). */
export async function closePostgres(): Promise<void> {
  for (const pool of pgPools.values()) await pool.end({ timeout: 2 });
  pgPools.clear();
  bootstrapped.clear();
  // Le pool du store d'auth (schéma public) vit dans driver-postgres-auth : sans
  // sa fermeture, un processus de test ne rend jamais la main.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { closeAuthPool } = require("./driver-postgres-auth") as typeof import("./driver-postgres-auth");
    await closeAuthPool();
  } catch { /* module non chargé */ }
  if (_pglite && "close" in _pglite) await (_pglite as unknown as { close(): Promise<void> }).close();
  _pglite = null;
  _pgliteSchema = null;
}
