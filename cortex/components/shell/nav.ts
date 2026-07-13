import {
  LayoutDashboard,
  Search,
  ListTree,
  Target,
  ClipboardList,
  Dumbbell,
  Folder,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
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
  { href: "/", label: "Accueil", Icon: LayoutDashboard },
  { href: "/recherche", label: "Recherche", Icon: Search },
  { href: "/programme", label: "Programme", Icon: ListTree },
  { href: "/faiblesses", label: "Faiblesses", Icon: Target },
  { href: "/examens", label: "Examens", Icon: ClipboardList },
  { href: "/entrainement", label: "Entraînement", Icon: Dumbbell },
  { href: "/sources", label: "Sources", Icon: Folder },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
