import { CalendarDays, ListTree, ChartNoAxesCombined, Dumbbell, Folder, UserRound, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; Icon: LucideIcon };

export const NAV: NavItem[] = [
  { href: "/", label: "Aujourd’hui", Icon: CalendarDays },
  { href: "/programme", label: "Programme", Icon: ListTree },
  { href: "/seance", label: "S’entraîner", Icon: Dumbbell },
  { href: "/faiblesses", label: "Progrès", Icon: ChartNoAxesCombined },
];

export const SECONDARY_NAV: NavItem[] = [
  { href: "/sources", label: "Sources", Icon: Folder },
  { href: "/compte", label: "Compte", Icon: UserRound },
];

export function isActive(pathname: string, href: string) {
  if (href === "/seance" && (["/entrainement", "/examens", "/revision", "/qa"].includes(pathname) || pathname.startsWith("/mock/"))) return true;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
