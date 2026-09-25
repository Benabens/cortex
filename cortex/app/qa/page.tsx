"use client";

/**
 * /qa — Visual QA harness. Renders every UI/viz primitive in every state.
 * Not linked from the nav; used to audit rendering at all breakpoints.
 */

import { useState } from "react";
import {
  Play,
  Sparkles,
  Check,
  Search,
  Folder,
  Repeat2,
  CircleDot,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Info,
  CircleDashed,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Panel, SectionHeader, Toggle, Kbd } from "@/components/ui/primitives";
import { RadialGauge } from "@/components/viz/RadialGauge";
import { WaffleGrid } from "@/components/viz/WaffleGrid";
import { WeightBar } from "@/components/viz/WeightBar";
import { OpportunityBar } from "@/components/viz/OpportunityBar";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { Sparkline } from "@/components/viz/Sparkline";
import { ForgettingCurve } from "@/components/viz/ForgettingCurve";
import { cn } from "@/lib/ux/cn";

function QA({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel rounded-xl p-5">
      <h2 className="mb-4 text-[0.95rem] font-semibold text-ink-1">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.7rem] text-ink-4">{children}</span>;
}

export default function QAPage() {
  const [t1, setT1] = useState(false);
  const [t2, setT2] = useState(true);
  const [t3, setT3] = useState(true);
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(true);
  const [sl, setSl] = useState(50);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[1.9rem] font-semibold leading-tight">QA — composants & états</h1>
        <p className="mt-1 text-[0.9rem] text-ink-2">
          Chaque primitive, chaque état, plusieurs valeurs. Page d’audit, hors nav.
        </p>
      </div>

      {/* BUTTONS */}
      <QA title="Button — variants × tailles × états">
        <div className="space-y-4">
          {(["primary", "secondary", "ghost", "subtle"] as const).map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <span className="w-20 shrink-0 text-[0.72rem] uppercase tracking-wider text-ink-4">{v}</span>
              <Button variant={v} size="sm">Petit</Button>
              <Button variant={v} size="md">Moyen</Button>
              <Button variant={v} size="lg">Grand</Button>
              <Button variant={v} size="md" disabled>Désactivé</Button>
              <Button variant={v} size="md" loading>Chargement…</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 shrink-0 text-[0.72rem] uppercase tracking-wider text-ink-4">icônes</span>
            <Button variant="primary"><Play className="size-4" fill="currentColor" />Lancer</Button>
            <Button variant="secondary"><Sparkles className="size-4" />Générer</Button>
          </div>
        </div>
      </QA>

      {/* TOGGLES + CHECKBOX */}
      <QA title="Switch / Toggle & Checkbox — off · on · focus · disabled">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex items-center gap-2"><Toggle checked={t1} onChange={setT1} label="Off" /><Label>off</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={t2} onChange={setT2} label="On" /><Label>on</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={t3} onChange={setT3} label="Focus" autoFocus /><Label>focus (autofocus)</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={false} onChange={() => {}} label="Disabled off" disabled /><Label>disabled off</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={true} onChange={() => {}} label="Disabled on" disabled /><Label>disabled on</Label></div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4 border-t border-line pt-4">
          {[{ v: c1, set: setC1, l: "off" }, { v: c2, set: setC2, l: "on" }].map(({ v, set, l }) => (
            <button
              key={l}
              type="button"
              role="checkbox"
              aria-checked={v}
              onClick={() => set(!v)}
              className="flex items-center gap-2.5"
            >
              <span className={cn(
                "grid size-5 place-items-center rounded-[5px] border transition-colors",
                v ? "border-transparent bg-violet-deep text-white" : "border-line-strong bg-surface-2"
              )}>
                {v && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <Label>checkbox {l}</Label>
            </button>
          ))}
          <span className="flex items-center gap-2.5 opacity-45">
            <span className="grid size-5 place-items-center rounded-[5px] border border-line-strong bg-surface-2" />
            <Label>checkbox disabled</Label>
          </span>
        </div>
      </QA>

      {/* BADGES */}
      <QA title="Badge — tous les tons × tailles × emphase">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={CircleDashed}>Neutral</Badge>
          <Badge tone="violet" Icon={Repeat2}>Violet</Badge>
          <Badge tone="info" Icon={CircleDot}>Info</Badge>
          <Badge tone="success" Icon={CheckCircle2}>Success</Badge>
          <Badge tone="warning" Icon={AlertTriangle}>Warning</Badge>
          <Badge tone="danger" Icon={ShieldAlert}>Danger</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="violet" Icon={Info} size="xs">Taille xs</Badge>
          <Badge tone="success" Icon={Check} size="sm">Taille sm</Badge>
          <Badge tone="danger" Icon={ShieldAlert} emphasis>Emphase</Badge>
        </div>
      </QA>

      {/* INPUTS */}
      <QA title="Inputs — vide · rempli · focus · erreur (hauteur ≥ 44px)">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>vide (placeholder)</Label>
            <input type="text" placeholder="Rechercher un thème…" aria-label="Démo vide"
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]" />
          </div>
          <div className="space-y-1.5">
            <Label>rempli</Label>
            <input type="text" defaultValue="Descente de gradient" aria-label="Démo remplie"
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]" />
          </div>
          <div className="space-y-1.5">
            <Label>focus (simulé)</Label>
            <input type="text" defaultValue="SVM & kernels" aria-label="Démo focus"
              className="h-11 w-full rounded-lg border bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] ring-2 ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)] focus:outline-none" />
          </div>
          <div className="space-y-1.5">
            <Label>erreur</Label>
            <input type="text" defaultValue="???" aria-invalid="true" aria-describedby="qa-err" aria-label="Démo erreur"
              className="h-11 w-full rounded-lg border bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 border-[color-mix(in_oklch,var(--color-danger)_55%,transparent)] ring-2 ring-[color-mix(in_oklch,var(--color-danger)_25%,transparent)] focus:outline-none" />
            <p id="qa-err" className="text-[0.78rem] text-danger-hi">Thème introuvable — essaie « SVM » ou « MLP ».</p>
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          <Label>textarea</Label>
          <textarea rows={2} placeholder="Colle une discussion…" aria-label="Démo textarea"
            className="w-full resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]" />
        </div>
      </QA>

      {/* SLIDER + STEPPER */}
      <QA title="Slider (0 · 50 · 100) & Stepper">
        <div className="space-y-4">
          {[0, 50, 100].map((v) => (
            <div key={v} className="flex items-center gap-4">
              <span className="w-10 shrink-0 text-right font-data text-[0.85rem] tabular text-ink-2">{v}</span>
              <input type="range" min={0} max={100} defaultValue={v} aria-label={`Slider à ${v}`}
                className="slider" style={{ ["--fill" as string]: `${v}%` }} />
            </div>
          ))}
          <div className="flex items-center gap-4">
            <span className="w-10 shrink-0 text-right font-data text-[0.85rem] tabular text-ink-2">{sl}</span>
            <input type="range" min={0} max={100} value={sl} onChange={(e) => setSl(Number(e.target.value))}
              aria-label="Slider interactif" className="slider" style={{ ["--fill" as string]: `${sl}%` }} />
          </div>
          <div className="flex items-center gap-3 border-t border-line pt-4">
            <Label>stepper</Label>
            <div className="w-44 rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="flex items-center justify-between">
                <button type="button" aria-label="Diminuer" className="grid size-9 place-items-center rounded-md border border-line bg-surface-2 text-ink-2 hover:bg-surface-3">−</button>
                <span className="font-data text-[1.4rem] font-semibold tabular text-ink-1">4</span>
                <button type="button" aria-label="Augmenter" className="grid size-9 place-items-center rounded-md border border-line bg-surface-2 text-ink-2 hover:bg-surface-3">+</button>
              </div>
            </div>
          </div>
        </div>
      </QA>

      {/* CHIPS / KBD / ROWS */}
      <QA title="Chips · Kbd · Rangées (default / hover simulé / focus)">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed="true" className="inline-flex h-9 items-center gap-2 rounded-full border border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] px-3 text-[0.82rem] font-medium text-ink-1">
            Chip actif <span className="font-data text-[0.72rem] tabular text-ink-4">12</span>
          </button>
          <button type="button" aria-pressed="false" className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface-1/60 px-3 text-[0.82rem] font-medium text-ink-2 hover:bg-surface-2">
            Chip inactif <span className="font-data text-[0.72rem] tabular text-ink-4">4</span>
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem] font-medium text-ink-2">
            <Folder className="size-3.5" /> Dossier <span className="font-data text-[0.72rem] tabular text-ink-4">6</span>
          </button>
          <span className="flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Search className="size-4 text-ink-3" /><span className="flex-1 text-[0.88rem] text-ink-1">Rangée default</span><Label>—</Label>
          </div>
          <div className="flex items-center gap-3 border-t border-line bg-surface-2/60 px-3 py-2.5">
            <Search className="size-4 text-ink-2" /><span className="flex-1 text-[0.88rem] text-ink-1">Rangée hover (simulée)</span><Label>bg-surface-2</Label>
          </div>
          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-2.5 ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-violet)_35%,transparent)]">
            <Search className="size-4 text-violet-hi" /><span className="flex-1 text-[0.88rem] text-ink-1">Rangée sélectionnée</span><Label>ring violet</Label>
          </div>
        </div>
        <div className="mt-4 w-56 overflow-hidden rounded-lg border border-line p-3">
          <p className="truncate text-[0.88rem] text-ink-1">Troncature : un titre beaucoup trop long pour tenir ici</p>
          <Label>truncate 224px</Label>
        </div>
      </QA>

      {/* EMPTY + SKELETON */}
      <QA title="Empty state & Skeleton">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="grid place-items-center rounded-lg border border-line px-6 py-10 text-center">
            <Search className="size-7 text-ink-4" strokeWidth={1.75} />
            <p className="mt-3 text-[0.95rem] font-medium text-ink-1">Aucun résultat</p>
            <p className="mt-1 max-w-xs text-[0.85rem] text-ink-3">Essaie un autre terme, ou retire un filtre.</p>
          </div>
          <div className="space-y-3 rounded-lg border border-line p-4">
            <div className="skeleton h-5 w-2/3" />
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="flex gap-3 pt-1">
              <div className="skeleton size-10 rounded-lg" />
              <div className="flex-1 space-y-2"><div className="skeleton h-4 w-1/2" /><div className="skeleton h-3 w-1/3" /></div>
            </div>
          </div>
        </div>
      </QA>

      {/* DATA-VIZ */}
      <QA title="Data-viz — RadialGauge · WaffleGrid (0 % · 50 % · 100 %)">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {[0, 47, 100].map((v) => (
            <div key={v} className="grid place-items-center rounded-lg border border-line p-4">
              <RadialGauge value={v} label="Maîtrise" sublabel={`valeur ${v} %`} size={140} />
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {[{ f: 0 }, { f: 18 }, { f: 36 }].map(({ f }) => (
            <div key={f} className="rounded-lg border border-line p-4">
              <Label>{f}/36</Label>
              <div className="mt-2"><WaffleGrid total={36} filled={f} columns={9} label={`Waffle ${f}/36`} /></div>
            </div>
          ))}
        </div>
      </QA>

      <QA title="Data-viz — WeightBar · OpportunityBar · SeverityMeter · Sparkline · ForgettingCurve">
        <div className="space-y-3">
          {[0, 50, 100].map((v) => (
            <div key={v} className="flex items-center gap-3">
              <span className="w-10 shrink-0 text-right font-data text-[0.8rem] tabular text-ink-3">{v}%</span>
              <WeightBar pct={v} glow={v === 100} />
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          {[{ w: 16, m: 0 }, { w: 8, m: 50 }, { w: 4, m: 100 }].map(({ w, m }) => (
            <div key={`${w}-${m}`} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-right text-[0.72rem] text-ink-4">poids {w} · maîtrise {m}</span>
              <OpportunityBar weightPct={w} masteryPct={m} maxWeight={16} />
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-8 border-t border-line pt-4">
          <div className="flex items-center gap-3"><SeverityMeter level={1} tone="info" /><Label>léger</Label></div>
          <div className="flex items-center gap-3"><SeverityMeter level={2} tone="warning" /><Label>moyen</Label></div>
          <div className="flex items-center gap-3"><SeverityMeter level={3} tone="danger" /><Label>sévère</Label></div>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-8 border-t border-line pt-4">
          <div><Label>sparkline montante</Label><div className="mt-1"><Sparkline values={[40, 41, 43, 42, 45, 47]} /></div></div>
          <div><Label>sparkline plate</Label><div className="mt-1"><Sparkline values={[50, 50, 50, 50, 50]} /></div></div>
          <div><Label>courbe de l’oubli</Label><div className="mt-1"><ForgettingCurve width={220} height={80} /></div></div>
        </div>
      </QA>

      {/* PANEL + FOCUS CLIPPING */}
      <QA title="Panel interactif & focus-ring près d’un bord overflow-hidden">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel interactive className="p-4">
            <SectionHeader title="Panel interactif" hint="hover : lift + bordure violette" action={{ label: "Action", href: "/qa" }} />
            <p className="text-[0.85rem] text-ink-2">Contenu…</p>
          </Panel>
          <div className="panel overflow-hidden rounded-xl p-1.5">
            <div className="rounded-lg p-2">
              <span
                className="inline-flex rounded-md"
                style={{ outline: "2px solid var(--color-violet)", outlineOffset: 2 }}
              >
                <Button variant="secondary" size="sm">Ring simulé près du bord (clippé ?)</Button>
              </span>
            </div>
          </div>
        </div>
      </QA>
    </div>
  );
}
