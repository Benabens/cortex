/**
 * Helpers Recherche — sur les VRAIES formes de GET /api/search?q= :
 * { groups:[{sourceType, label, hits:[{itemId, sourceId, sourceType, sourceTitle,
 *   sourcePath, lectureId, title, anchor, snippet}]}], total }.
 * Le snippet FTS marque les correspondances avec « … » (guillemets français).
 */

import {
  Repeat2,
  PenLine,
  GraduationCap,
  ScrollText,
  Presentation,
  BookOpen,
  Code2,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { Tone } from "@/lib/ux/labels";

export type Hit = {
  itemId: number;
  sourceId: number;
  sourceType: string;
  sourceTitle: string;
  sourcePath: string;
  lectureId: number | null;
  title: string;
  anchor: string;
  snippet: string;
};

export type Group = { sourceType: string; label: string; hits: Hit[] };
export type SearchResp = { groups: Group[]; total: number };

/** Suggestions COURSE-AWARE — reprises de l'écran validé de l'app. */
export const SUGGEST: Record<string, string[]> = {
  "cs-202": ["memory image", "fork", "TCP slow start", "inode", "page fault", "longest prefix", "scheduling"],
  ml: ["overfitting", "SVM", "K-means", "gradient descent", "backprop", "PCA", "régularisation"],
  algo: ["Master Theorem", "Dijkstra", "dynamic programming", "BFS / DFS", "greedy", "SCC", "complexité"],
};

/** Méta d'affichage par sourceType RÉEL (fallback générique pour l'inconnu). */
export const TYPE_META: Record<string, { Icon: LucideIcon; tone: Tone }> = {
  review: { Icon: Repeat2, tone: "violet" },
  course_pdf: { Icon: Presentation, tone: "neutral" },
  lecture: { Icon: BookOpen, tone: "neutral" },
  final: { Icon: GraduationCap, tone: "warning" },
  midterm: { Icon: GraduationCap, tone: "warning" },
  serie: { Icon: PenLine, tone: "info" },
  exercise: { Icon: PenLine, tone: "info" },
  cheatsheet: { Icon: ScrollText, tone: "success" },
  code: { Icon: Code2, tone: "violet" },
};

export function metaFor(sourceType: string) {
  return TYPE_META[sourceType] ?? { Icon: FileText, tone: "neutral" as Tone };
}

/**
 * Lien clic→source — réplique CLIENT-SAFE de lib/deeplink.ts (le module back
 * importe Node et ne peut pas être bundlé côté client ; même logique, ne pas diverger) :
 * cs-202 : HTML → viewer /voir (déplie + surligne), sinon /sites/<anchor> ;
 * autres cours : /csrc?course&p=<sourcePath> + fragment #page=N de l'anchor.
 */
export function hitHref(course: string, h: Hit, q: string): string {
  if (course === "cs-202") {
    if (h.sourcePath.endsWith(".html")) {
      const item = h.itemId != null ? `&item=${h.itemId}` : "";
      const query = q ? `&q=${encodeURIComponent(q)}` : "";
      return `/voir?src=${encodeURIComponent(h.sourcePath)}${item}${query}`;
    }
    return `/sites/${h.anchor}`;
  }
  const frag = h.anchor.includes("#") ? "#" + h.anchor.split("#")[1] : "";
  return `/csrc?course=${encodeURIComponent(course)}&p=${encodeURIComponent(h.sourcePath)}${frag}`;
}

/** Découpe un snippet FTS sur les marqueurs « … » → segments {text, hit}. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}
