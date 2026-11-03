import { CalendarDays, Search, ClipboardList, Target, ListTree, Dumbbell, Folder, UserRound, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; Icon: LucideIcon };

export const NAV: NavItem[] = [
  { href: "/", label: "Aujourd’hui", Icon: CalendarDays },
  { href: "/recherche", label: "Recherche", Icon: Search },
  { href: "/programme", label: "Programme", Icon: ListTree },
  { href: "/faiblesses", label: "Faiblesses", Icon: Target },
  { href: "/examens", label: "Examens", Icon: ClipboardList },
  { href: "/entrainement", label: "Entraînement", Icon: Dumbbell },
];

export const MOBILE_NAV: NavItem[] = [
  NAV[0], NAV[2], NAV[4], NAV[5],
];

export const SECONDARY_NAV: NavItem[] = [
  { href: "/sources", label: "Sources", Icon: Folder },
  { href: "/compte", label: "Compte", Icon: UserRound },
];

export function isActive(pathname: string, href: string) {
  if (href === "/examens" && pathname.startsWith("/mock/")) return true;
  if (href === "/entrainement" && ["/seance", "/revision"].includes(pathname)) return true;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
