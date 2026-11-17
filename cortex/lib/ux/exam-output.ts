import { useCallback, useSyncExternalStore } from "react";

/**
 * SORTIE D'UN EXAMEN : sur le site (questions interactives, correction en ligne) ou en PDF (la
 * mise en page relevée dans l'annale à la préparation du cours, sinon une mise en page sobre).
 * Les deux existent pour chaque examen, au même prix : le PDF est compilé à la génération, sans
 * appel au modèle. Le choix ne fait qu'ouvrir l'un ou l'autre ; il est retenu dans ce navigateur.
 */
export type ExamOutput = "site" | "pdf";

const KEY = "cortex.examOutput";

/** Le choix retenu (« site » par défaut, ou si le navigateur refuse le stockage). */
export function readExamOutput(): ExamOutput {
  try {
    return window.localStorage.getItem(KEY) === "pdf" ? "pdf" : "site";
  } catch {
    return "site";
  }
}

export function writeExamOutput(o: ExamOutput): void {
  try {
    window.localStorage.setItem(KEY, o);
  } catch {
    // stockage refusé (navigation privée) : le choix vaut pour cette page seulement
  }
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/** Sortie demandée par l'adresse (`?sortie=pdf`, lien « Ouvrir le PDF » du compositeur), sinon celle retenue. */
function snapshot(fromUrl: boolean): ExamOutput {
  if (fromUrl) {
    const asked = new URLSearchParams(window.location.search).get("sortie");
    if (asked === "pdf" || asked === "site") return asked;
  }
  return readExamOutput();
}

/**
 * La sortie choisie et de quoi la changer. Rendu serveur : « site » (le stockage ne se lit que dans
 * le navigateur). `fromUrl` : l'adresse l'emporte, jusqu'au premier choix (qui la retire).
 */
export function useExamOutput(fromUrl = false): [ExamOutput, (o: ExamOutput) => void] {
  const output = useSyncExternalStore(subscribe, () => snapshot(fromUrl), () => "site" as const);
  const choose = useCallback((o: ExamOutput) => {
    writeExamOutput(o);
    if (fromUrl) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("sortie")) {
        url.searchParams.delete("sortie");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    listeners.forEach((l) => l());
  }, [fromUrl]);
  return [output, choose];
}
