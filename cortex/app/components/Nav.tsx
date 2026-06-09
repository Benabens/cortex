"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/recherche", label: "Recherche" },
  { href: "/faiblesses", label: "Faiblesses" },
  { href: "/examens", label: "Examens" },
  { href: "/entrainement", label: "Entraînement" },
  { href: "/sources", label: "Sources" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand">
        Cortex
      </Link>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="nav-link"
          data-active={path === l.href || path.startsWith(l.href + "/")}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
