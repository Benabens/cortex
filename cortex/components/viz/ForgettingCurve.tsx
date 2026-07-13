"use client";

import { useId } from "react";

type Props = {
  width?: number;
  height?: number;
  /** fraction along x where the optimal review is scheduled (0–1) */
  reviewAt?: number;
  className?: string;
};

/**
 * Signature forgetting-curve viz: retention decays over time, and Cortex marks
 * the optimal moment to review — the core idea of the product, drawn as light.
 */
export function ForgettingCurve({
  width = 240,
  height = 88,
  reviewAt = 0.58,
  className,
}: Props) {
  const id = useId().replace(/:/g, "");
  const padX = 4;
  const padTop = 8;
  const padBottom = 6;
  const w = width;
  const h = height;

  const decay = (x: number) => Math.exp(-2.4 * x);
  const toX = (x: number) => padX + x * (w - padX * 2);
  const toY = (r: number) => h - padBottom - r * (h - padTop - padBottom);

  const N = 40;
  const pts = Array.from({ length: N + 1 }, (_, i) => {
    const x = i / N;
    return `${toX(x).toFixed(2)},${toY(decay(x)).toFixed(2)}`;
  });
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${toX(1).toFixed(2)},${(h - padBottom).toFixed(2)} L ${toX(0).toFixed(
    2
  )},${(h - padBottom).toFixed(2)} Z`;

  const mx = toX(reviewAt);
  const my = toY(decay(reviewAt));

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Courbe de l'oubli : la rétention décroît avec le temps ; Cortex planifie le rappel avant que ça décroche."
    >
      <defs>
        <linearGradient id={`fc-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-violet)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--color-violet)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`fc-line-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-violet-hi)" />
          <stop offset="100%" stopColor="var(--color-cyan)" />
        </linearGradient>
      </defs>

      {/* baseline */}
      <line
        x1={padX}
        y1={h - padBottom}
        x2={w - padX}
        y2={h - padBottom}
        stroke="var(--color-line)"
        strokeWidth="1"
      />
      <path d={area} fill={`url(#fc-fill-${id})`} />
      <path
        d={line}
        fill="none"
        stroke={`url(#fc-line-${id})`}
        strokeWidth="2.25"
        strokeLinecap="round"
        pathLength={1}
        className="path-draw"
      />

      {/* review marker */}
      <line
        x1={mx}
        y1={my}
        x2={mx}
        y2={h - padBottom}
        stroke="var(--color-cyan)"
        strokeWidth="1"
        strokeDasharray="2 3"
        opacity="0.7"
      />
      <circle cx={mx} cy={my} r="6.5" fill="var(--color-cyan)" opacity="0.18" />
      <circle
        cx={mx}
        cy={my}
        r="3.4"
        fill="var(--color-bg)"
        stroke="var(--color-cyan)"
        strokeWidth="2"
      />
    </svg>
  );
}
