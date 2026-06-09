/**
 * Ancrage visuel : les vraies pages d'examen rendues en image, que Claude Code (Max)
 * REGARDE (outil Read, vision) avant de générer/vérifier — pour calquer la richesse des
 * figures, la densité et la difficulté sur de vrais exemplaires plutôt que de deviner.
 *
 * Images curées (commitées) dans cortex/data/refs/figref/. Chemins relatifs au cwd (cortex/).
 */
export type FigRef = { type: string; img: string; shows: string };

export const FIGURE_REFS: FigRef[] = [
  { type: "Networking — topologie", img: "data/refs/figref/topo_2024.png", shows: "Figure 1 réelle : AS + routeurs, switches L2, clusters d'end-systems étiquetés, COÛTS de liens (rose), DÉBITS (vert), boîtes d'INTERFACES orange nommées, nuage « Rest of the Internet ». Pleine largeur, légende numérotée." },
  { type: "Networking — topologie (2025)", img: "data/refs/figref/topo_2025.png", shows: "autre vraie topologie EPFL." },
  { type: "Networking — TCP", img: "data/refs/figref/tcp_2024.png", shows: "Figure 2 réelle : diagramme TCP en échelle scaffoldé — colonnes (receiver window / congestion window / ssthresh / état du congestion control / Sequence number / Acknowledgement number), deux timelines verticales (serveur/ client), handshake SYN/SYNACK/HTTP GET pré-tracé, ligne de valeurs initiales, espace à remplir." },
  { type: "OS — file system / inodes", img: "data/refs/figref/filesystem_2024.png", shows: "vraie question file system (inodes, blocs, accès)." },
  { type: "OS — fork & threads (ÉTALON DE PROFONDEUR)", img: "data/refs/figref/fork_threads_2024.png", shows: "Final 2024 Q3 : UN programme concret (forking + multi-threading) creusé par 5-7 sous-questions en escalier testant les interactions, avec un vrai piège (déterminisme). C'EST LE NIVEAU DE FOND À ATTEINDRE." },
  { type: "OS — scheduling", img: "data/refs/figref/scheduling_2024.png", shows: "vraie question scheduling (Gantt / états)." },
  { type: "C / Labs — lecture de code", img: "data/refs/figref/code_2024.png", shows: "vraie question de lecture/compréhension de code." },
  { type: "C / Labs — lecture de code (2025)", img: "data/refs/figref/code_2025.png", shows: "autre vraie question de code." },
];

// Sous-ensemble d'images-étalon pour la GÉNÉRATION (5, pas 8 → plus rapide ; 1 par grand type).
const GEN_REF_TYPES = [
  "Networking — topologie",
  "Networking — TCP",
  "OS — file system / inodes",
  "OS — fork & threads (ÉTALON DE PROFONDEUR)",
  "C / Labs — lecture de code",
];

/** Bloc à insérer dans le prompt : demande au modèle de REGARDER les vraies pages. */
export function visionBlock(): string {
  const refs = FIGURE_REFS.filter((f) => GEN_REF_TYPES.includes(f.type));
  return [
    `═══ ANCRAGE VISUEL — REGARDE D'ABORD CES VRAIES PAGES D'EXAMEN (outil Read) ═══`,
    `Avant d'écrire, OUVRE et OBSERVE ces images (vraies pages de finals EPFL). Calque la RICHESSE des figures, la DENSITÉ, la DIFFICULTÉ et les PIÈGES sur ces exemplaires — produis du NEUF du même niveau, sans recopier :`,
    ...refs.map((f) => `  - ${f.img}  →  ${f.type} : ${f.shows}`),
    `Pour chaque exercice, identifie son TYPE et vise le niveau visuel + de difficulté de la page correspondante.`,
  ].join("\n");
}

/** Sous-ensemble d'images pertinent pour la vérification (difficulté/figures). */
export function verifyVisionImages(): string[] {
  return FIGURE_REFS.map((f) => f.img);
}

/** Image de la vraie page-étalon du même type qu'un exercice (pour vérif/régénération ciblées). */
export function refImageFor(category?: string, concept?: string): string {
  const c = `${category ?? ""} ${concept ?? ""}`.toLowerCase();
  if (/tcp|congestion|reno|tahoe|slow start|seq|ack|throughput/.test(c)) return "data/refs/figref/tcp_2024.png";
  if (/topolog|subnet|forward|packet|routing|prefix|\barp\b|delay|bellman|dijkstra/.test(c)) return "data/refs/figref/topo_2024.png";
  if (/schedul|mlfq|round robin|turnaround/.test(c)) return "data/refs/figref/scheduling_2024.png";
  if (/fork|thread|process|race|exec|wait/.test(c)) return "data/refs/figref/fork_threads_2024.png";
  if (/inode|disk|file system|filesystem|block|offset|index/.test(c)) return "data/refs/figref/filesystem_2024.png";
  if (/lab|code|socket|client|server|direntv6|syscall/.test(c)) return "data/refs/figref/code_2024.png";
  return "data/refs/figref/topo_2024.png";
}
