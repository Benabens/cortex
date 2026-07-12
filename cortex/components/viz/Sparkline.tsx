"use client";

import { useId } from "react";

type Props = {
  values: number[];
  width?: number;
  height?: number;
  from?: string;
  to?: string;
  className?: string;
  ariaLabel?: string;
};

/** Compact gradient-fill trend line for at-a-glance progress. */
export function Sparkline({
  values,
  width = 120,
  height = 34,
  from = "var(--color-violet-hi)",
  to = "var(--color-cyan)",
  className,
  ariaLabel,
}: Props) {
  const id = useId().replace(/:/g, "");
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max - min === 0;
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1 || 1);
  const toX = (i: number) => pad + i * stepX;
  // Flat series draw as a mid-height line instead of collapsing to the baseline.
  const toY = (v: number) =>
    flat ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2);

  const pts = values.map((v, i) => `${toX(i).toFixed(2)},${toY(v).toFixed(2)}`);
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${toX(values.length - 1).toFixed(2)},${height - pad} L ${pad},${
    height - pad
  } Z`;
  const last = values[values.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={ariaLabel ?? "Tendance récente"}
    >
      <defs>
        <linearGradient id={`sp-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={from} stopOpacity="0.28" />
          <stop offset="100%" stopColor={from} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`sp-line-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sp-fill-${id})`} />
      <path
        d={line}
        fill="none"
        stroke={`url(#sp-line-${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className="path-draw"
      />
      <circle cx={toX(values.length - 1)} cy={toY(last)} r="2.6" fill={to} />
    </svg>
  );
}
