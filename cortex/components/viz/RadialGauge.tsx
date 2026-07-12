"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useCountUp, useReducedMotion } from "@/lib/ux/hooks";

/** Polar point with 0° at top, increasing clockwise. */
function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** Clockwise arc path from startAngle to endAngle (degrees, 0 = top). */
function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

type Props = {
  /** 0–100 */
  value: number;
  size?: number;
  thickness?: number;
  label: string;
  sublabel?: string;
  from?: string;
  to?: string;
  /** total sweep of the dial in degrees (default 270 → instrument gauge) */
  sweep?: number;
};

export function RadialGauge({
  value,
  size = 168,
  thickness = 12,
  label,
  sublabel,
  from = "var(--color-violet)",
  to = "var(--color-cyan)",
  sweep = 270,
}: Props) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const count = useCountUp(value, 1100);

  const cx = size / 2;
  const cy = size / 2;
  const r = (size - thickness) / 2 - 2;
  const startAngle = -sweep / 2;
  const endAngle = sweep / 2;
  const track = arcPath(cx, cy, r, startAngle, endAngle);

  // reveal the value arc via dashoffset (pathLength normalized to 1)
  const target = Math.max(0, Math.min(1, value / 100));
  const [offset, setOffset] = useState(reduced ? 1 - target : 1);
  const started = useRef(false);
  useEffect(() => {
    if (reduced) {
      setOffset(1 - target);
      return;
    }
    const t = requestAnimationFrame(() => {
      started.current = true;
      setOffset(1 - target);
    });
    return () => cancelAnimationFrame(t);
  }, [target, reduced]);

  return (
    <div
      className="relative inline-grid place-items-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label} : ${value}%${sublabel ? `, ${sublabel}` : ""}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
        <defs>
          <linearGradient id={`grad-${id}`} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
          <filter id={`glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* track */}
        <path
          d={track}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {/* soft glow underlay */}
        <path
          d={track}
          fill="none"
          stroke={`url(#grad-${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={offset}
          filter={`url(#glow-${id})`}
          opacity={0.5}
          style={{ transition: reduced ? "none" : "stroke-dashoffset 1.15s var(--ease-out-quint)" }}
        />
        {/* crisp value arc */}
        <path
          d={track}
          fill="none"
          stroke={`url(#grad-${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={offset}
          style={{ transition: reduced ? "none" : "stroke-dashoffset 1.15s var(--ease-out-quint)" }}
        />
      </svg>

      <div className="absolute inset-0 grid place-items-center text-center">
        <div className="-mt-1">
          <div className="font-data text-[2.35rem] font-semibold leading-none text-ink-1">
            {count}
            <span className="ml-0.5 align-top text-lg font-medium text-ink-3">%</span>
          </div>
          {sublabel && <div className="mt-1.5 text-xs text-ink-3">{sublabel}</div>}
        </div>
      </div>
    </div>
  );
}
