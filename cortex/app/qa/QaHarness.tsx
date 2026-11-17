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
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Toggle } from "@/components/ui/Toggle";
import { Segmented } from "@/components/ui/Segmented";
import { RadialGauge } from "@/components/viz/RadialGauge";
import { WaffleGrid } from "@/components/viz/WaffleGrid";
import { WeightBar } from "@/components/viz/WeightBar";
import { OpportunityBar } from "@/components/viz/OpportunityBar";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { Sparkline } from "@/components/viz/Sparkline";
import { ForgettingCurve } from "@/components/viz/ForgettingCurve";
import { cn } from "@/lib/ux/cn";
import { useTranslations } from "use-intl/react";

function QA({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="d2-card p-5">
      <h2 className="mb-4 text-[0.95rem] font-semibold text-ink-1">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.7rem] text-ink-4">{children}</span>;
}

export function QaHarness() {
  const t = useTranslations("qa");
  const [t1, setT1] = useState(false);
  const [t2, setT2] = useState(true);
  const [t3, setT3] = useState(true);
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(true);
  const [sl, setSl] = useState(50);
  const [seg, setSeg] = useState("section");
  const [segSm, setSegSm] = useState("list");
  const [pill, setPill] = useState("all");
  const [chip, setChip] = useState("annales");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[1.9rem] font-semibold leading-tight">{t("title")}</h1>
        <p className="mt-1 text-[0.9rem] text-ink-2">
          {t("description")}
        </p>
      </div>

      {/* BUTTONS */}
      <QA title={t("buttonsTitle")}>
        <div className="space-y-4">
          {(["primary", "secondary", "ghost", "subtle"] as const).map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <span className="w-20 shrink-0 text-[0.72rem] text-ink-4">{v}</span>
              <Button variant={v} size="sm">{t("small")}</Button>
              <Button variant={v} size="md">{t("medium")}</Button>
              <Button variant={v} size="lg">{t("large")}</Button>
              <Button variant={v} size="md" disabled>{t("disabled")}</Button>
              <Button variant={v} size="md" loading>{t("loading")}</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-20 shrink-0 text-[0.72rem] text-ink-4">{t("icons")}</span>
            <Button variant="primary"><Play className="size-4" fill="currentColor" />{t("launch")}</Button>
            <Button variant="secondary"><Sparkles className="size-4" />{t("generate")}</Button>
          </div>
        </div>
      </QA>

      {/* SEGMENTED — le seul contrôle « une option parmi N » : glisse, s'étire, rebondit, se comprime à l'appui */}
      <QA title={t("segmentedTitle")}>
        <div className="flex flex-col items-start gap-4">
          <Segmented
            label={t("railDemo")}
            options={[
              { value: "section", label: t("bySection"), Icon: Folder },
              { value: "priority", label: t("byPriority"), Icon: Sparkles },
            ]}
            value={seg}
            onChange={setSeg}
          />
          <Segmented
            size="sm"
            label={t("compactRailDemo")}
            options={[
              { value: "list", label: t("list") },
              { value: "chapter", label: t("byChapter") },
              { value: "date", label: t("byDate") },
            ]}
            value={segSm}
            onChange={setSegSm}
          />
          <Segmented
            variant="pills"
            label={t("pillsDemo")}
            options={[
              { value: "all", label: t("all"), count: 12 },
              { value: "high", label: t("severe"), count: 4 },
              { value: "mid", label: t("average"), count: 6 },
              { value: "low", label: t("light"), count: 2 },
            ]}
            value={pill}
            onChange={setPill}
          />
          <Segmented
            variant="chips"
            label={t("chipsDemo")}
            options={[
              { value: "annales", label: t("pastExams"), count: 9 },
              { value: "cours", label: t("coursesPdf"), count: 14 },
              { value: "series", label: t("series"), count: 6 },
            ]}
            value={chip}
            onChange={setChip}
          />
        </div>
      </QA>

      {/* TOGGLES + CHECKBOX */}
      <QA title={t("togglesTitle")}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex items-center gap-2"><Toggle checked={t1} onChange={setT1} label={t("off")} /><Label>{t("off").toLowerCase()}</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={t2} onChange={setT2} label={t("on")} /><Label>{t("on").toLowerCase()}</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={t3} onChange={setT3} label={t("focus")} autoFocus /><Label>{t("focusAutofocus")}</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={false} onChange={() => {}} label={t("disabledOff")} disabled /><Label>{t("disabledOff").toLowerCase()}</Label></div>
          <div className="flex items-center gap-2"><Toggle checked={true} onChange={() => {}} label={t("disabledOn")} disabled /><Label>{t("disabledOn").toLowerCase()}</Label></div>
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
                v ? "border-transparent bg-accent-deep text-white" : "border-line-strong bg-surface-2"
              )}>
                {v && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <Label>{t("checkbox", { state: l })}</Label>
            </button>
          ))}
          <span className="flex items-center gap-2.5 opacity-45">
            <span className="grid size-5 place-items-center rounded-[5px] border border-line-strong bg-surface-2" />
            <Label>{t("checkboxDisabled")}</Label>
          </span>
        </div>
      </QA>

      {/* BADGES */}
      <QA title={t("badgesTitle")}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" Icon={CircleDashed}>{t("neutral")}</Badge>
          <Badge tone="accent" Icon={Repeat2}>{t("accent")}</Badge>
          <Badge tone="info" Icon={CircleDot}>{t("info")}</Badge>
          <Badge tone="success" Icon={CheckCircle2}>{t("success")}</Badge>
          <Badge tone="warning" Icon={AlertTriangle}>{t("warning")}</Badge>
          <Badge tone="danger" Icon={ShieldAlert}>{t("danger")}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone="accent" Icon={Info} size="xs">{t("sizeXs")}</Badge>
          <Badge tone="success" Icon={Check} size="sm">{t("sizeSm")}</Badge>
          <Badge tone="danger" Icon={ShieldAlert} emphasis>{t("emphasis")}</Badge>
        </div>
      </QA>

      {/* INPUTS */}
      <QA title={t("inputsTitle")}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("emptyPlaceholder")}</Label>
            <input type="text" placeholder={t("searchTheme")} aria-label={t("emptyDemo")}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-accent)_28%,transparent)]" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("filled")}</Label>
            <input type="text" defaultValue={t("filledValue")} aria-label={t("filledDemo")}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-accent)_28%,transparent)]" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("simulatedFocus")}</Label>
            <input type="text" defaultValue={t("focusValue")} aria-label={t("focusDemo")}
              className="h-11 w-full rounded-lg border bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] ring-2 ring-[color-mix(in_oklch,var(--color-accent)_28%,transparent)] focus:outline-none" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("error")}</Label>
            <input type="text" defaultValue="???" aria-invalid="true" aria-describedby="qa-err" aria-label={t("errorDemo")}
              className="h-11 w-full rounded-lg border bg-surface-2/40 px-3.5 text-[0.9rem] text-ink-1 border-[color-mix(in_oklch,var(--color-danger)_55%,transparent)] ring-2 ring-[color-mix(in_oklch,var(--color-danger)_25%,transparent)] focus:outline-none" />
            <p id="qa-err" className="text-[0.78rem] text-danger-hi">{t("themeNotFound")}</p>
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          <Label>{t("textarea")}</Label>
          <textarea rows={2} placeholder={t("pasteDiscussion")} aria-label={t("textareaDemo")}
            className="w-full resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:outline-none focus:border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-accent)_28%,transparent)]" />
        </div>
      </QA>

      {/* SLIDER + STEPPER */}
      <QA title={t("sliderTitle")}>
        <div className="space-y-4">
          {[0, 50, 100].map((v) => (
            <div key={v} className="flex items-center gap-4">
              <span className="w-10 shrink-0 text-right font-data text-[0.85rem] tabular text-ink-2">{v}</span>
              <input type="range" min={0} max={100} defaultValue={v} aria-label={t("sliderAt", { value: v })}
                className="slider" style={{ ["--fill" as string]: `${v}%` }} />
            </div>
          ))}
          <div className="flex items-center gap-4">
            <span className="w-10 shrink-0 text-right font-data text-[0.85rem] tabular text-ink-2">{sl}</span>
            <input type="range" min={0} max={100} value={sl} onChange={(e) => setSl(Number(e.target.value))}
              aria-label={t("interactiveSlider")} className="slider" style={{ ["--fill" as string]: `${sl}%` }} />
          </div>
          <div className="flex items-center gap-3 border-t border-line pt-4">
            <Label>{t("stepper")}</Label>
            <div className="w-44 rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="flex items-center justify-between">
                <button type="button" aria-label={t("decrease")} className="grid size-9 place-items-center rounded-md border border-line bg-surface-2 text-ink-2 hover:bg-surface-3">−</button>
                <span className="font-data text-[1.4rem] font-semibold tabular text-ink-1">4</span>
                <button type="button" aria-label={t("increase")} className="grid size-9 place-items-center rounded-md border border-line bg-surface-2 text-ink-2 hover:bg-surface-3">+</button>
              </div>
            </div>
          </div>
        </div>
      </QA>

      {/* CHIPS / KBD / ROWS */}
      <QA title={t("rowsTitle")}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed="true" className="inline-flex h-9 items-center gap-2 rounded-full border border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] px-3 text-[0.82rem] font-medium text-ink-1">
            {t("activeChip")} <span className="font-data text-[0.72rem] tabular text-ink-4">12</span>
          </button>
          <button type="button" aria-pressed="false" className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface-1/60 px-3 text-[0.82rem] font-medium text-ink-2 hover:bg-surface-2">
            {t("inactiveChip")} <span className="font-data text-[0.72rem] tabular text-ink-4">4</span>
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem] font-medium text-ink-2">
            <Folder className="size-3.5" /> {t("folder")} <span className="font-data text-[0.72rem] tabular text-ink-4">6</span>
          </button>

        </div>
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <Search className="size-4 text-ink-3" /><span className="flex-1 text-[0.88rem] text-ink-1">{t("defaultRow")}</span><Label>—</Label>
          </div>
          <div className="flex items-center gap-3 border-t border-line bg-surface-2/60 px-3 py-2.5">
            <Search className="size-4 text-ink-2" /><span className="flex-1 text-[0.88rem] text-ink-1">{t("hoverRow")}</span><Label>{t("surfaceToken")}</Label>
          </div>
          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-2.5 ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-accent)_35%,transparent)]">
            <Search className="size-4 text-accent-hi" /><span className="flex-1 text-[0.88rem] text-ink-1">{t("selectedRow")}</span><Label>{t("accentRing")}</Label>
          </div>
        </div>
        <div className="mt-4 w-56 overflow-hidden rounded-lg border border-line p-3">
          <p className="truncate text-[0.88rem] text-ink-1">{t("truncation")}</p>
          <Label>{t("truncateToken")}</Label>
        </div>
      </QA>

      {/* EMPTY + SKELETON */}
      <QA title={t("emptyTitle")}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="grid place-items-center rounded-lg border border-line px-6 py-10 text-center">
            <Search className="size-7 text-ink-4" strokeWidth={1.75} />
            <p className="mt-3 text-[0.95rem] font-medium text-ink-1">{t("noResult")}</p>
            <p className="mt-1 max-w-xs text-[0.85rem] text-ink-3">{t("noResultHint")}</p>
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
      <QA title={t("gaugeTitle")}>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {[0, 47, 100].map((v) => (
            <div key={v} className="grid place-items-center rounded-lg border border-line p-4">
              <RadialGauge value={v} label={t("mastery")} sublabel={t("valuePercent", { value: v })} size={140} />
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {[{ f: 0 }, { f: 18 }, { f: 36 }].map(({ f }) => (
            <div key={f} className="rounded-lg border border-line p-4">
              <Label>{f}/36</Label>
              <div className="mt-2"><WaffleGrid total={36} filled={f} columns={9} label={t("waffle", { filled: f })} /></div>
            </div>
          ))}
        </div>
      </QA>

      <QA title={t("vizTitle")}>
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
              <span className="w-24 shrink-0 text-right text-[0.72rem] text-ink-4">{t("weightMastery", { weight: w, mastery: m })}</span>
              <OpportunityBar weightPct={w} masteryPct={m} maxWeight={16} />
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-8 border-t border-line pt-4">
          <div className="flex items-center gap-3"><SeverityMeter level={1} tone="info" /><Label>{t("severityLight")}</Label></div>
          <div className="flex items-center gap-3"><SeverityMeter level={2} tone="warning" /><Label>{t("severityMedium")}</Label></div>
          <div className="flex items-center gap-3"><SeverityMeter level={3} tone="danger" /><Label>{t("severityHigh")}</Label></div>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-8 border-t border-line pt-4">
          <div><Label>{t("risingSparkline")}</Label><div className="mt-1"><Sparkline values={[40, 41, 43, 42, 45, 47]} /></div></div>
          <div><Label>{t("flatSparkline")}</Label><div className="mt-1"><Sparkline values={[50, 50, 50, 50, 50]} /></div></div>
          <div><Label>{t("forgettingCurve")}</Label><div className="mt-1"><ForgettingCurve width={220} height={80} /></div></div>
        </div>
      </QA>

      {/* PANEL + FOCUS CLIPPING */}
      <QA title={t("panelTitle")}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel interactive className="p-4">
            <SectionHeader title={t("interactivePanel")} hint={t("panelHint")} action={{ label: t("action"), href: "/qa" }} />
            <p className="text-[0.85rem] text-ink-2">{t("content")}</p>
          </Panel>
          <div className="panel overflow-hidden rounded-xl p-1.5">
            <div className="rounded-lg p-2">
              <span
                className="inline-flex rounded-md"
                style={{ outline: "2px solid var(--color-accent)", outlineOffset: 2 }}
              >
                <Button variant="secondary" size="sm">{t("simulatedRing")}</Button>
              </span>
            </div>
          </div>
        </div>
      </QA>
    </div>
  );
}
