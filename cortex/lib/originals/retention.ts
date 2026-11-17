import { createHash } from "node:crypto";
import path from "node:path";
import { authGet, authRun } from "@/db/auth-store";
import { runWithCourse } from "@/db/client";
import { runWithUser } from "@/db/context";
import { nowStr, q } from "@/db/q";
import { coursePaths, getCourse, listCourses } from "@/lib/courses";
import { log } from "@/lib/metrics";
import { purgePdfPages } from "@/lib/page-cache";
import { coursePathOf, settleOriginals } from "@/lib/originals/intake";
import { originalsPolicy, originalsRuleActive, type OriginalsPolicy } from "@/lib/originals/policy";
import { localOriginals, recordLocal } from "@/lib/originals/registry";
import { storage } from "@/lib/storage";

/**
 * RÉTENTION DES ORIGINAUX D'UN COMPTE QUI N'EST PLUS (OU PAS) PREMIUM — règle annoncée :
 * les originaux déjà rangés dans le cloud y restent RETENTION_DAYS (30) jours après la fin du
 * Premium (lib/originals/policy, `cloudUntil`), puis sont supprimés ; leur index reste, et le
 * fichier peut être renvoyé depuis l'ordinateur. Un compte qui n'a jamais été Premium et avait des
 * fichiers d'avant la règle : 30 jours après l'entrée en vigueur de la règle (app_meta
 * `originals_rule_since`, posé au premier passage). Les examens générés par Cortex ne sont pas
 * des originaux : ils restent. Le passage est horaire, sur chaque instance (le transit est sur
 * son disque) ; il est idempotent, et saute un cours dont un job tourne.
 */

export const RETENTION_DAYS = 30;
const DAY_MS = 86400_000;
const RULE_KEY = "originals_rule_since";
const TICK_MS = 3600_000;

const parse = (s: string) => Date.parse(`${s.slice(0, 19).replace(" ", "T")}Z`);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Date d'entrée en vigueur de la règle (posée une fois, au premier appel avec la règle active). */
export async function ruleSince(now: string = nowStr()): Promise<string | null> {
  if (!originalsRuleActive()) return null;
  await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, RULE_KEY, now);
  return (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, RULE_KEY))?.value ?? now;
}

/** Jour où les originaux encore dans le cloud d'un compte gratuit sont supprimés ; null = jamais (Premium). */
export function purgeDate(policy: OriginalsPolicy, since: string | null): string | null {
  if (policy.home !== "local" || !since) return null;
  const base = [policy.cloudUntil, since].filter((d): d is string => !!d).sort().at(-1)!;
  return stamp(parse(base) + RETENTION_DAYS * DAY_MS);
}

/** Ce que l'interface annonce à un compte : où vont ses originaux, et jusqu'à quand le cloud les garde. */
export type OriginalsNotice = { home: OriginalsPolicy["home"]; reason: OriginalsPolicy["reason"]; wasPremium: boolean; purgeOn: string | null };

export async function originalsNotice(userId: string): Promise<OriginalsNotice> {
  const policy = await originalsPolicy(userId);
  const purgeOn = policy.home === "local" ? purgeDate(policy, await ruleSince().catch(() => null)) : null;
  return { home: policy.home, reason: policy.reason, wasPremium: !!policy.cloudUntil, purgeOn };
}

/**
 * État des originaux du cours courant pour la page Sources : où vont les nouveaux fichiers, ceux
 * restés sur l'ordinateur, et combien attendent encore leur suppression du cloud (fin du Premium).
 */
export async function courseOriginals(userId: string, courseId: string): Promise<OriginalsNotice & { onComputer: string[]; cloudFiles: number }> {
  const notice = await originalsNotice(userId);
  const rows = await localOriginals();
  const onComputer = rows.filter((o) => o.state === "local").map((o) => o.path);
  let cloudFiles = 0;
  if (notice.home === "local" && notice.purgeOn && !getCourse(courseId).paths) {
    const known = new Set(rows.map((o) => o.path));
    await q.ensureTable("sources");
    cloudFiles = (await q.all<{ path: string }>(`SELECT DISTINCT path FROM sources`)).filter((r) => !known.has(r.path)).length;
  }
  return { ...notice, onComputer, cloudFiles };
}

type CourseReport = { transitPurged: number; cloudPurged: number };

/** Supprime les originaux du cloud du cours courant ; garde au registre ceux qui ont un index. */
async function purgeCloudOriginals(courseId: string): Promise<number> {
  const { refsDir, contentRoot, uploadsDir } = coursePaths(courseId);
  const inTransit = new Set((await localOriginals("transit")).map((o) => o.path));
  await q.ensureTable("sources");
  let n = 0;
  for (const dir of [refsDir, contentRoot, uploadsDir]) {
    for (const f of await storage().list(dir)) {
      const coursePath = coursePathOf(courseId, f.path);
      if (coursePath && inTransit.has(coursePath)) continue;
      if (coursePath && !coursePath.startsWith("uploads/")) {
        const indexed = await q.get(`SELECT 1 AS one FROM sources WHERE path = ? LIMIT 1`, coursePath);
        const data = indexed ? await storage().read(f.path) : null;
        if (data) {
          await recordLocal({
            path: coursePath, name: path.basename(f.path), sha256: createHash("sha256").update(data).digest("hex"),
            size: data.length, origin: "purge",
          });
        }
      }
      await storage().remove(f.path);
      if (coursePath?.startsWith("refs/")) purgePdfPages(courseId, path.basename(f.path));
      n++;
    }
  }
  return n;
}

/** Un passage sur les cours d'un compte : transit échu, puis cloud échu. */
export async function sweepAccount(userId: string, now: string = nowStr()): Promise<CourseReport> {
  const out: CourseReport = { transitPurged: 0, cloudPurged: 0 };
  const policy = await originalsPolicy(userId, now);
  if (policy.home !== "local") return out;
  const due = purgeDate(policy, await ruleSince(now));
  const cloudDue = !!due && now >= due;
  for (const c of listCourses().filter((x) => x.ownerUserId === userId && !x.paths)) {
    await runWithUser(userId, () => runWithCourse(c.id, async () => {
      const { activeJob } = await import("@/lib/jobs");
      if (await activeJob()) return;
      const settled = await settleOriginals({ after: "expiry", now });
      out.transitPurged += settled.purged + settled.dropped;
      if (cloudDue) out.cloudPurged += await purgeCloudOriginals(c.id);
    }));
  }
  return out;
}

/** Tous les comptes propriétaires d'un cours. */
export async function sweepOriginals(now: string = nowStr()): Promise<CourseReport> {
  const out: CourseReport = { transitPurged: 0, cloudPurged: 0 };
  if (!originalsRuleActive()) return out;
  for (const userId of new Set(listCourses().filter((c) => !c.paths).map((c) => c.ownerUserId))) {
    try {
      const r = await sweepAccount(userId, now);
      out.transitPurged += r.transitPurged;
      out.cloudPurged += r.cloudPurged;
    } catch (e) {
      log("error", "originals.sweep_failed", { user: userId, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  if (out.transitPurged || out.cloudPurged) log("info", "originals.sweep", out);
  return out;
}

/** Démarre le passage horaire (une minuterie par process). null sans la règle. */
export function startOriginalsSweep(): NodeJS.Timeout | null {
  const g = globalThis as { __cortexOriginalsTimer?: NodeJS.Timeout };
  if (g.__cortexOriginalsTimer) clearInterval(g.__cortexOriginalsTimer);
  if (!originalsRuleActive()) return null;
  const tick = () => void sweepOriginals().catch((e) => log("error", "originals.sweep_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
  setTimeout(tick, 120_000).unref?.();
  g.__cortexOriginalsTimer = setInterval(tick, TICK_MS);
  g.__cortexOriginalsTimer.unref?.();
  return g.__cortexOriginalsTimer;
}
