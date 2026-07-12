"use client";

import { useEffect, useRef, useState } from "react";

/** True when the user prefers reduced motion (SSR-safe: false on first paint). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

/**
 * Animate a number from 0 → value once on mount.
 * Honors reduced motion (jumps straight to the final value).
 */
export function useCountUp(value: number, duration = 900, decimals = 0): number {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = easeOutQuint(t);
      const factor = Math.pow(10, decimals);
      setDisplay(Math.round(value * eased * factor) / factor);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    // Deterministic settle: guarantee the exact final value even if rAF is throttled.
    const settle = setTimeout(() => setDisplay(value), duration + 60);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      clearTimeout(settle);
    };
  }, [value, duration, decimals, reduced]);

  return display;
}

/** Fires once when the element scrolls into view (for lazy reveals). */
export function useInViewOnce<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, inView };
}
