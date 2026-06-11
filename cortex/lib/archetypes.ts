/**
 * Bibliothèque d'archétypes de questions CS-202 — chaque archétype décrit la STRUCTURE
 * d'une vraie question de la prof (concept, construction, grille de réponse, figure, piège).
 * La génération PART d'un archétype et ré-instancie sur un nouveau setup (≠ recopie).
 */
export type Archetype = {
  id: string;
  category: "Networking" | "OS" | "C" | "Labs";
  concept: string;
  structure: string; // comment construire la question (sous-questions en escalier)
  grid: string; // grille(s) de réponse à émettre
  figure: string; // macro de figure verrouillée à utiliser
  trap: string; // le piège classique qui sépare compréhension et application mécanique
  weight: number; // poids study guide (importance relative dans le tirage)
  topics: string[]; // mots-clés pour matcher les faiblesses de Ben
};

export const ARCHETYPES: Archetype[] = [
  {
    id: "packet-trace",
    category: "Networking",
    concept: "Subnets, forwarding and full packet trace",
    structure: "Sur \\examtopo : 1) allocation de préfixes minimale (PETIT volume), 2) forwarding table / longest-prefix, 3) packet-trace COMPLET à une interface (ARP + DNS récursif + TCP) en escalier.",
    grid: "\\forwardgrid{5} pour le forwarding, \\packetgrid{12} pour la trace",
    figure: "\\examtopo (obligatoire, en tête d'énoncé)",
    trap: "longest-prefix avec égalité apparente / destination hors agrégat / ARP confiné au sous-réseau (les switches L2 ne font pas d'ARP)",
    weight: 3,
    topics: ["subnet", "prefix", "forwarding", "arp", "dns", "packet"],
  },
  {
    id: "tcp-reno",
    category: "Networking",
    concept: "TCP congestion control (Tahoe vs Reno) and delays",
    structure: "Référence à Figure 1 (pas de nouvelle figure). 1) handshake + SEQ/ACK bookkeeping, 2) évolution cwnd/ssthresh sur N RTTs (\\tcpladder), 3) perte par triple-ACK vs timeout (Tahoe vs Reno), 4) délai bout-en-bout multi-saut avec bottleneck.",
    grid: "\\tcpladder{D_1}{A_1}{...}{1 MSS}{$\\infty$}{8} + \\rulelines pour les justifications",
    figure: "\\tcpladder",
    trap: "ACK = prochain octet attendu (pas +1) ; différence Tahoe/Reno sur triple-ACK ; ne pas multiplier la propagation par le nb de bits",
    weight: 3,
    topics: ["tcp", "reno", "tahoe", "congestion", "cwnd", "ssthresh", "delay", "throughput", "ack"],
  },
  {
    id: "inode-walk",
    category: "OS",
    concept: "Disk access, inodes and multi-level indexing",
    structure: "UN fichier + UNE séquence open/lseek/read/write concrète. 1) tailles max par niveau d'indirection, 2) comptage d'accès blocs étape par étape (\\diskgrid), 3) effet du cache, 4) cas sparse/frontière.",
    grid: "\\diskgrid{8}",
    figure: "\\examinode",
    trap: "lecture qui CHEVAUCHE la frontière direct→single-indirect ; trous (sparse) lus comme zéros ; bloc déjà en cache non recompté",
    weight: 3,
    topics: ["inode", "disk", "block", "indexing", "lseek", "offset", "file system", "cache"],
  },
  {
    id: "fork-sched",
    category: "OS",
    concept: "fork/exec/wait, process states and CPU scheduling",
    structure: "UN programme concret avec fork/exec/wait (arbre via examproctree). 1) combien de processus / qui imprime quoi, 2) arbre à construire, 3) simulation d'états multi-lignes (\\statesim) sous FIFO/SJF/STCF/RR/MLFQ avec turnaround/response, 4) data race + fix lock()/unlock().",
    grid: "\\statesim{16} + \\rulelines",
    figure: "examproctree (+ \\examstates si utile)",
    trap: "le fils reprend APRÈS le fork (pas de fork infini) ; valeur de variable déterministe mais ENTRELACEMENT non ; RR sans durées connues ; single-core",
    weight: 3,
    topics: ["fork", "exec", "wait", "scheduling", "mlfq", "round robin", "process", "thread", "race", "lock"],
  },
  {
    id: "c-reading",
    category: "C",
    concept: "Reading lab-style C code",
    structure: "UN extrait de code C lab-style (sockets ou file I/O) en lstlisting. Questions de LECTURE : quels syscalls, quels file descriptors, que fait ce code, que vaut X — jamais écrire/débugger.",
    grid: "\\rulelines{4} par sous-question",
    figure: "(aucune — le code EST l'artefact)",
    trap: "library call vs syscall (fopen→open) ; fd hérités après fork ; valeur de retour de fork",
    weight: 1,
    topics: ["c code", "syscall", "socket", "file descriptor", "read", "write"],
  },
  {
    id: "labs-reading",
    category: "Labs",
    concept: "Lab artifact reading (client-server or direntv6)",
    structure: "UN vrai artefact de lab en LECTURE : get_file/send_file/socket_layer OU direntv6 inode walk. 1) que fait cette fonction, 2) tracer un appel concret, 3) quels syscalls sous-jacents, 4) que se passe-t-il si X échoue.",
    grid: "\\rulelines{4-6}",
    figure: "(le code) — éventuellement \\examinode pour direntv6",
    trap: "ordre des appels socket (socket/bind/listen/accept vs connect) ; inode walk = résolution composant par composant",
    weight: 1,
    topics: ["lab", "direntv6", "get_file", "send_file", "socket_layer", "client", "server"],
  },
];
