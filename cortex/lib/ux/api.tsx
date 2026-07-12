"use client";

/**
 * Couche d'accès aux VRAIES routes /api/* pour la nouvelle UX.
 * - CourseProvider : cours courant (init : ?course= → localStorage → cs-202),
 *   persisté, propagé à tous les fetchs via `?course=` (priorité n°1 du back, cf. lib/req.ts).
 * - useApi<T> : fetch + états loading/error, cache mémoire + dédup des requêtes en vol
 *   (Topbar et page partagent la même requête /api/dashboard sans doublon réseau).
 * - apiPost : POST JSON, erreurs typées (le 503 « Claude Max non joignable » se gère à l'écran).
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

export type CourseInfo = { id: string; short: string; name: string };

/** Mêmes cours réels que l'ancien sélecteur (pas de route /api/courses côté back). */
export const COURSES: CourseInfo[] = [
  { id: "cs-202", short: "CS-202", name: "Computer Systems" },
  { id: "algo", short: "CS-250", name: "Algorithms" },
  { id: "ml", short: "CS-233", name: "Introduction to Machine Learning" },
];

const LS_KEY = "cortex-course";
const DEFAULT_COURSE = "cs-202";

function readInitialCourse(): string {
  if (typeof window === "undefined") return DEFAULT_COURSE;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("course");
    if (fromUrl && COURSES.some((c) => c.id === fromUrl)) {
      localStorage.setItem(LS_KEY, fromUrl);
      return fromUrl;
    }
    const stored = localStorage.getItem(LS_KEY);
    if (stored && COURSES.some((c) => c.id === stored)) return stored;
  } catch {}
  return DEFAULT_COURSE;
}

type CourseCtx = {
  courseId: string;
  course: CourseInfo;
  /** false tant que le cours initial (URL/localStorage) n'est pas résolu — les fetchs attendent. */
  ready: boolean;
  setCourseId: (id: string) => void;
};

const Ctx = createContext<CourseCtx | null>(null);

export function CourseProvider({ children }: { children: React.ReactNode }) {
  // Démarre sur le défaut côté SSR puis se synchronise côté client (pas de mismatch d'hydratation).
  const [courseId, setId] = useState(DEFAULT_COURSE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setId(readInitialCourse());
    setReady(true);
  }, []);

  const setCourseId = useCallback((id: string) => {
    if (!COURSES.some((c) => c.id === id)) return;
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {}
    cache.clear(); // nouveau cours → toutes les données changent
    setId(id);
  }, []);

  const value = useMemo<CourseCtx>(
    () => ({
      courseId,
      course: COURSES.find((c) => c.id === courseId) ?? COURSES[0],
      ready,
      setCourseId,
    }),
    [courseId, ready, setCourseId]
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
  const url = path && ready ? withCourse(path, courseId) : null;
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
    if (!url) return;
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
  }, [url, tick]);

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
