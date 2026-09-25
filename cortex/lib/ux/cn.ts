export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[];

/** Minimal classnames joiner — flattens arrays, drops falsy values. */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const v of inputs) {
    if (!v) continue;
    if (Array.isArray(v)) {
      const inner = cn(...v);
      if (inner) out.push(inner);
    } else {
      out.push(String(v));
    }
  }
  return out.join(" ");
}
