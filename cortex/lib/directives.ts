import { q } from "@/db/q";

/**
 * Directives du staff CS-202 — contraintes DURES pour la génération d'examen.
 * Source : Study Guide officiel (Moodle, Katerina Argyraki) + threads forum Ed,
 * vérifiés le 2026-06-09. Voir notes/STUDY_GUIDE_OFFICIAL_VERBATIM.md,
 * notes/EXAM_HINTS_UPDATE_2026-06-09.md, notes/EXAM_HINTS_FROM_STAFF.md.
 *
 * ⚠️ Une question générée qui viole une EXCLUSION est un bug : à ne pas produire.
 */
export type Directives = {
  exclude: string[];
  include: string[];
  assumptions: string[];
  format: string[];
};

export const DIRECTIVES: Directives = {
  exclude: [
    "Paging comme EXERCICE : segmentation vs paging reste un concept à connaître, mais AUCUN exercice de paging (pas de calcul de page table, pas de calcul VPN/PFN/offset-de-page comme exo dédié).",
    "Elevator algorithm et disk scheduling (non couverts — TA, Ed #761 ; c'est pourquoi le Final '24 Q5 est exclu).",
    "Poisoned reverses (non couvert — Katerina, Ed #738).",
    "Security protocols ; et P2P au-delà du trivial (« rien de compliqué » — Study Guide).",
    "Code C COMPLEXE : ne JAMAIS demander d'ÉCRIRE ou DÉBUGGER du code, ni de raisonner sur des pointeurs / arithmétique de pointeurs.",
    "Concurrence en code complexe : pas d'exercice de programmation avec locks / condition variables / sémaphores au-delà de l'idée-clé.",
  ],
  include: [
    "Les OFFSETS sont au programme (lseek, file descriptors & offsets, slides 48-52) — ne PAS les exclure.",
    "Reno est au programme (pas seulement Tahoe) — préciser Tahoe/Reno dans l'énoncé ou le rendre déductible (Ed #702).",
    "TOUT le semestre est examinable, y compris le contenu du midterm. Le CPU scheduling (FIFO/SJF/STCF/RR/MLFQ) peut tomber même s'il était absent du Final '24 (JCC, Ed #768).",
    "Le C « lab-style » peut apparaître en LECTURE/COMPRÉHENSION (reconnaître des syscalls, fork/exec/wait/waitpid, file descriptors, sockets) — jamais en écriture/débug. Le 8% Labs n'est PAS un plafond du C.",
    "Concurrence — le PLUS dur acceptable : montrer un petit bout de code avec un bug de concurrence (data race) et demander d'ajouter lock()/unlock() au bon endroit (Katerina, Ed #711). Rien de plus complexe.",
  ],
  assumptions: [
    "CPU single-core par défaut, sauf mention explicite (Katerina, Ed #609).",
    "Round Robin ne suppose AUCUNE durée de job connue (Katerina, Ed #742).",
    "Web → TCP ; DNS → UDP. Caches web et DNS activés par défaut, TTL 1 h.",
    "Packet switches : store-and-forward, files FIFO de taille infinie, processing delay = 0.",
    "Un read() non caché = un accès disque (TA, Ed #775).",
    "Délai bout-en-bout : on ADDITIONNE les composantes ; on ne multiplie pas la propagation par le nb de bits, ni toutes les composantes par le nb de paquets.",
    "TCP : ACK = numéro du prochain octet attendu (octets 1..100 reçus → ACK 101, pas ACK 2).",
    "RÉDUIS le volume : pas de très grandes allocations de préfixes IP ni de très longues listes d'échanges de paquets (le mécanisme reste examinable, mais en PETIT).",
  ],
  format: [
    "LANGUE : 100% ANGLAIS — titres ET corps de tous les énoncés et corrigés en anglais. Aucun français dans l'examen.",
    "Modèles de format = past-exams avec leurs exclusions : CompSys Final '25 (SAUF Q3.3 et Q6), Final '24 (SAUF Q5), CompNet finals Problem 2 (sauf Q4) & Problem 3.",
    "Structure calquée sur le Final 2025 : 6 exercices indépendants, ~180 points, répartition Networking (2) / OS (2) / C (1) / Labs (1).",
    "Cette année les LABS remplacent le Projet (8% = Labs : code client-serveur, filesystem direntv6, multi-threading). La 6e question = LABS : lecture/compréhension d'un bout de code lab-style (reconnaître syscalls, fork/exec/wait, file descriptors, sockets) — PAS « Project/DKVS ».",
    "PRINCIPE DE CONSTRUCTION (le plus important) : chaque grosse question (≥25 pts) part d'UN SEUL artefact concret et non-trivial (un programme, une topologie, un file system + programme, une trace) creusé par 5-7 SOUS-QUESTIONS EN ESCALIER (difficulté croissante) qui testent les INTERACTIONS entre concepts (fork×threads×section critique ; routage×ARP×forwarding ; inode×cache×offsets), avec AU MOINS UN VRAI PIÈGE (cas-limite, frontière, déterminisme). Profondeur > largeur. Pas de snippets déconnectés ni de simples vrai/faux.",
    "DIFFICULTÉ : niveau d'un vrai final EPFL — nombres NON RONDS (P=3 ms, R=12 Mbps…), charge de calcul/bookkeeping réelle, cas multi-saut / frontière. L'étudiant moyen doit transpirer.",
  ],
};

/** Bloc de contraintes dures à mettre EN TÊTE du prompt de génération. */
export function directivesBlock(): string {
  const L = (a: string[]) => a.map((s) => `  - ${s}`).join("\n");
  return [
    `═══════════════════════════════════════════════════════════════════════════`,
    `CONTRAINTES DURES — DIRECTIVES DU STAFF (Study Guide officiel + forum Ed, vérifiées 2026-06-09)`,
    `Ces règles PRIMENT sur tout le reste, y compris sur les past-exams. Une question qui viole une`,
    `EXCLUSION est un BUG : ne la génère pas, remplace-la par un sujet autorisé.`,
    `═══════════════════════════════════════════════════════════════════════════`,
    ``,
    `⛔ NE GÉNÈRE AUCUNE QUESTION SUR (ou alors uniquement de façon triviale) :`,
    L(DIRECTIVES.exclude),
    ``,
    `✅ AU CONTRAIRE, C'EST BIEN AU PROGRAMME (ne confonds pas avec une exclusion) :`,
    L(DIRECTIVES.include),
    ``,
    `📐 HYPOTHÈSES & CONVENTIONS À RESPECTER DANS LES ÉNONCÉS :`,
    L(DIRECTIVES.assumptions),
    ``,
    `🧩 FORMAT :`,
    L(DIRECTIVES.format),
    `═══════════════════════════════════════════════════════════════════════════`,
  ].join("\n");
}

/** Texte brut des notes staff ingérées (study guide + hints) pour contexte additionnel. */
export async function staffNotesText(maxChars = 7000): Promise<string> {
  const rows = await q.all<{ text: string }>(
    `SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id
     WHERE s.type = 'note' AND (s.title LIKE 'STUDY_GUIDE%' OR s.title LIKE 'EXAM_HINTS%')
     ORDER BY (s.title LIKE 'STUDY_GUIDE%') DESC, s.title`
  );
  let out = rows.map((r) => r.text).join("\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + " […]";
  return out;
}
