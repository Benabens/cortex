import Link from "next/link";
import { SlidersHorizontal, Target, ListTree, ArrowUpRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Panel } from "@/components/ui/primitives";

type Action = {
  title: string;
  desc: string;
  href: string;
  Icon: LucideIcon;
  from: string;
  to: string;
};

const ACTIONS: Action[] = [
  {
    title: "Composer un examen",
    desc: "Répartis les points par type et lance un blanc.",
    href: "/examens",
    Icon: SlidersHorizontal,
    from: "var(--color-violet)",
    to: "var(--color-violet-deep)",
  },
  {
    title: "Driller un point faible",
    desc: "Cible une lacune et fais-toi corriger.",
    href: "/faiblesses",
    Icon: Target,
    from: "var(--color-cyan)",
    to: "var(--color-violet)",
  },
  {
    title: "Couvrir le programme",
    desc: "Attaque un type jamais vu à fort poids.",
    href: "/programme",
    Icon: ListTree,
    from: "var(--color-emerald)",
    to: "var(--color-cyan)",
  },
];

export function QuickActions() {
  return (
    <Panel className="p-5">
      <div className="mb-3 text-[0.72rem] font-medium uppercase tracking-wider text-ink-3">
        Actions rapides
      </div>
      <div className="flex flex-col gap-2">
        {ACTIONS.map(({ title, desc, href, Icon, from, to }) => (
          <Link
            key={title}
            href={href}
            className="group flex items-center gap-3.5 rounded-lg border border-line bg-surface-2/40 p-3 transition-[transform,border-color,background] duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)] hover:bg-surface-2"
          >
            <span
              className="grid size-10 shrink-0 place-items-center rounded-lg text-white"
              style={{
                background: `linear-gradient(145deg, ${from}, ${to})`,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28)",
              }}
            >
              <Icon className="size-[1.15rem]" strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9rem] font-medium text-ink-1">{title}</span>
              <span className="block text-[0.78rem] leading-snug text-ink-3">{desc}</span>
            </span>
            <ArrowUpRight className="size-4 shrink-0 text-ink-4 transition-colors group-hover:text-violet-hi" />
          </Link>
        ))}
      </div>
    </Panel>
  );
}
