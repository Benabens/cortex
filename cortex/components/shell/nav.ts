import {
  LayoutDashboard,
  Search,
  ListTree,
  Target,
  ClipboardList,
  Dumbbell,
  FolderTree,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  Icon: LucideIcon;
};

export const NAV: NavItem[] = [
  { href: "/", label: "Accueil", Icon: LayoutDashboard },
  { href: "/recherche", label: "Recherche", Icon: Search },
  { href: "/programme", label: "Programme", Icon: ListTree },
  { href: "/faiblesses", label: "Faiblesses", Icon: Target },
  { href: "/examens", label: "Examens", Icon: ClipboardList },
  { href: "/entrainement", label: "Entraînement", Icon: Dumbbell },
  { href: "/sources", label: "Sources", Icon: FolderTree },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
