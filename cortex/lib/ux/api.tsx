"use client";

/**
 * Couche d'accès aux VRAIES routes /api/* pour la nouvelle UX.
 * - CourseProvider : cours du compte, chargés depuis /api/courses ; cours courant
 *   (init : ?course= → localStorage → premier cours), persisté, propagé à tous les
 *   fetchs via `?course=` (priorité n°1 du back, cf. lib/req.ts).
 * - useApi<T> : fetch + états loading/error, cache mémoire + dédup des requêtes en vol
 *   (Topbar et page partagent la même requête /api/dashboard sans doublon réseau).
 * - apiPost : POST JSON, erreurs typées (le 503 « moteur LLM injoignable » se gère à l'écran).
 * - asText : garde anti-données corrompues (cs-202 renvoie des Buffer dans des champs texte).
 * - useJob : poll d'un job long via GET /api/jobs/[id].
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/* ---------------------------------------------------------------- courses */

/**
 * Les cours viennent de /api/courses — SCOPÉS au compte connecté. Il n'existe
 * plus de catalogue en dur côté client : un utilisateur ne peut donc pas
 * demander la matière d'un autre depuis le sélecteur.
 */
export type CourseInfo = {
  id: string;
  name: string;
  short: string;
  code: string;
  university: string;
  teachers: string[];
  language: string;
  examDate: string | null;
  durationMin: number;
  createdAt: string;
};

const LS_KEY = "cortex-course";

function storedCourse(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("course");
    if (fromUrl) return fromUrl;
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

type CourseCtx = {
  /** Cours du compte connecté (vide tant que la liste n'est pas chargée). */
  courses: CourseInfo[];
  /** Cours courant, "" si le compte n'en a aucun. */
  courseId: string;
  course: CourseInfo | null;
  /** false tant que la liste n'est pas revenue — les fetchs de données attendent. */
  ready: boolean;
  /** true = compte SANS aucun cours → état de premier lancement. */
  empty: boolean;
  error: string | null;
  setCourseId: (id: string) => void;
  /** Recharge la liste (après création/suppression) et renvoie la nouvelle liste. */
  refresh: (select?: string) => Promise<CourseInfo[]>;
};

const Ctx = createContext<CourseCtx | null>(null);

export function CourseProvider({ children }: { children: React.ReactNode }) {
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [courseId, setId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Choisit le cours courant : préférence mémorisée si elle existe encore, sinon le premier. */
  const pick = useCallback((list: CourseInfo[], wanted?: string): string => {
    const has = (id: string | null | undefined) => !!id && list.some((c) => c.id === id);
    if (has(wanted)) return wanted!;
    const remembered = storedCourse();
    if (has(remembered)) return remembered!;
    return list[0]?.id ?? "";
  }, []);

  const load = useCallback(
    async (select?: string): Promise<CourseInfo[]> => {
      try {
        const res = await fetch("/api/courses");
        if (!res.ok) throw new Error(`Erreur ${res.status}`);
        const data = (await res.json()) as { courses?: CourseInfo[] };
        const list = data.courses ?? [];
        setCourses(list);
        setError(null);
        const next = pick(list, select);
        setId(next);
        try {
          if (next) localStorage.setItem(LS_KEY, next);
          else localStorage.removeItem(LS_KEY);
        } catch {}
        return list;
      } catch (e) {
        setError((e as Error).message || "Impossible de charger tes cours.");
        return [];
      } finally {
        setReady(true);
      }
    },
    [pick]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const setCourseId = useCallback(
    (id: string) => {
      if (!courses.some((c) => c.id === id)) return; // un cours hors de SA liste n'est pas sélectionnable
      try {
        localStorage.setItem(LS_KEY, id);
      } catch {}
      cache.clear(); // nouveau cours → toutes les données changent
      setId(id);
    },
    [courses]
  );

  const value = useMemo<CourseCtx>(
    () => ({
      courses,
      courseId,
      course: courses.find((c) => c.id === courseId) ?? null,
      ready,
      empty: ready && !error && courses.length === 0,
      error,
      setCourseId,
      refresh: (select?: string) => {
        cache.clear();
        return load(select);
      },
    }),
    [courses, courseId, ready, error, setCourseId, load]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCourse(): CourseCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCourse doit être utilisé sous <CourseProvider>");
  return v;
}

/* ------------------------------------------------------------------ fetch */

export type ApiError = { status: number | null; message: string };

function withCourse(path: string, courseId: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}course=${encodeURIComponent(courseId)}`;
}

/** Cache mémoire simple + dédup des requêtes en vol, clé = URL complète. */
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

async function fetchJson<T>(url: string, force = false): Promise<T> {
  if (!force && cache.has(url)) return cache.get(url) as T;
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      let message = `Erreur ${res.status}`;
      try {
        const body = await res.json();
        if (typeof body?.error === "string") message = body.error;
      } catch {}
      const err: ApiError = { status: res.status, message };
      throw err;
    }
    const data = (await res.json()) as T;
    cache.set(url, data);
    return data;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

export type ApiState<T> = {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
};

/** GET une route /api/* pour le cours courant. Attend l'init du cours, relance quand il change. */
export function useApi<T>(path: string | null): ApiState<T> {
  const { courseId, ready } = useCourse();
  // Sans cours (compte neuf), aucune route de données n'a de sens : on n'appelle
  // rien plutôt que d'aller chercher un tenant vide et d'afficher une erreur.
  const url = path && ready && courseId ? withCourse(path, courseId) : null;
  const [data, setData] = useState<T | null>(null);
  // loading reste vrai tant qu'un chemin est demandé mais que le cours n'est pas résolu
  const [loading, setLoading] = useState<boolean>(!!path);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!url) {
      if (ready) setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<T>(url, tick > 0)
      .then((d) => {
        if (!cancelled && live.current) setData(d);
      })
      .catch((e: ApiError) => {
        if (!cancelled && live.current) {
          setData(null);
          setError(e?.message ? e : { status: null, message: "Connexion impossible" });
        }
      })
      .finally(() => {
        if (!cancelled && live.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick, ready]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refetch };
}

/** POST JSON vers une route /api/* pour le cours courant. Jette ApiError. */
export async function apiPost<T>(
  path: string,
  courseId: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(withCourse(path, courseId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {}
    const err: ApiError = { status: res.status, message };
    throw err;
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ hardening */

/**
 * Le back peut renvoyer un blob binaire ({type:"Buffer",data:[…]}) dans un champ
 * texte (bug data cs-202). On ne rend JAMAIS un objet brut : string propre ou null.
 */
export function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/* -------------------------------------------------------------------- jobs */

export type Job = {
  id: number;
  type: string | null;
  status: string;
  progress: number;
  currentStep: string | null;
  resultPath: string | null;
  error?: string | null;
};

export const JOB_ACTIVE = ["queued", "running", "verifying", "compiling"];

/** Poll GET /api/jobs/[id] tant que le job est actif (1,8 s d'intervalle). */
export function useJob(jobId: number | null): Job | null {
  const { courseId } = useCourse();
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    if (jobId == null) {
      setJob(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await fetch(withCourse(`/api/jobs/${jobId}`, courseId));
        if (res.ok) {
          const d = (await res.json()) as { job?: Job } & Job;
          const j = (d.job ?? d) as Job;
          if (!stop) setJob(j);
          if (!stop && JOB_ACTIVE.includes(j.status)) timer = setTimeout(poll, 1800);
          return;
        }
      } catch {}
      if (!stop) timer = setTimeout(poll, 4000); // erreur réseau transitoire → on réessaie
    };
    poll();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, courseId]);

  return job;
}
