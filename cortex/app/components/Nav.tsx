"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import CourseSwitcher from "./CourseSwitcher";

const LINKS = [
  { href: "/recherche", label: "Recherche" },
  { href: "/programme", label: "Programme" },
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
        <span className="nav-logo">C</span>
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
      <span style={{ marginLeft: "auto" }}>
        <CourseSwitcher />
      </span>
    </nav>
  );
}
