import {
  LayoutDashboard,
  Search,
  ListTree,
  Target,
  ClipboardList,
  Dumbbell,
  Folder,
  UserRound,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  labelKey: "home" | "search" | "syllabus" | "weakPoints" | "exams" | "practice" | "sources" | "account";
  Icon: LucideIcon;
};

/**
 * Icônes de nav — audit POLISH 2026 : une seule famille (lucide), stroke 2,
 * une métaphore par écran, pas de doublon visuel :
 * grille (vue d'ensemble) · loupe · liste hiérarchisée (syllabus) · cible ·
 * presse-papiers coché (examens) · haltère · dossier SIMPLE (le FolderTree
 * doublait la métaphore arbre de Programme et lisait « deux dossiers »).
 */
export const NAV: NavItem[] = [
  { href: "/", labelKey: "home", Icon: LayoutDashboard },
  { href: "/recherche", labelKey: "search", Icon: Search },
  { href: "/programme", labelKey: "syllabus", Icon: ListTree },
  { href: "/faiblesses", labelKey: "weakPoints", Icon: Target },
  { href: "/examens", labelKey: "exams", Icon: ClipboardList },
  { href: "/entrainement", labelKey: "practice", Icon: Dumbbell },
  { href: "/sources", labelKey: "sources", Icon: Folder },
  { href: "/compte", labelKey: "account", Icon: UserRound },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
