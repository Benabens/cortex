"use client";

import { useEffect, useState } from "react";

/**
 * Sélecteur de cours. cs-202 par défaut. Le cours est mémorisé en localStorage et propagé
 * à TOUTES les requêtes /api/* via un header `x-cortex-course` (patch fetch ci-dessous) →
 * aucune page existante à modifier. Les liens fichiers (/exam, /refs) portent déjà ?course=.
 */

const KEY = "cortex-course";
const COURSES = [
  { id: "cs-202", short: "CS-202", name: "Computer Systems" },
  { id: "algo", short: "Algo", name: "Algorithms" },
  { id: "ml", short: "ML", name: "Introduction to Machine Learning (CS-233)" },
];

function readCourse(): string {
  try {
    return localStorage.getItem(KEY) || "cs-202";
  } catch {
    return "cs-202";
  }
}

// --- patch fetch (installé une seule fois, au chargement du module client) ---
if (typeof window !== "undefined" && !(window as { __cortexFetchPatched?: boolean }).__cortexFetchPatched) {
  (window as { __cortexFetchPatched?: boolean }).__cortexFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
      if (typeof url === "string" && (url.startsWith("/api/") || url.includes("/api/"))) {
        const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("x-cortex-course", readCourse());
        init = { ...init, headers };
      }
    } catch {}
    return orig(input as RequestInfo, init);
  };
}

export default function CourseSwitcher() {
  const [course, setCourse] = useState("cs-202");
  useEffect(() => setCourse(readCourse()), []);

  function change(id: string) {
    try {
      localStorage.setItem(KEY, id);
    } catch {}
    setCourse(id);
    // recharge pour rafraîchir toutes les données du cours choisi
    window.location.reload();
  }

  return (
    <select
      value={course}
      onChange={(e) => change(e.target.value)}
      className="nav-link"
      title="Cours courant — change tout le contexte (corpus, faiblesses, examens)"
      style={{ background: "transparent", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px", cursor: "pointer" }}
    >
      {COURSES.map((c) => (
        <option key={c.id} value={c.id}>
          {c.short}
        </option>
      ))}
    </select>
  );
}
