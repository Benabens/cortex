import { maxConcurrency } from "./config";

/**
 * Limiteur de concurrence global des appels LLM (LLM_MAX_CONCURRENCY, défaut 4).
 * Permet de paralléliser les lots (génération/vérif) sans dépasser les rate
 * limits — les appels excédentaires attendent leur tour (FIFO).
 */

export class Semaphore {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`Semaphore : max doit être ≥ 1 (reçu ${max})`);
  }

  get active(): number {
    return this.inFlight;
  }

  get pending(): number {
    return this.queue.length;
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => { this.inFlight++; resolve(); }));
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

let _global: Semaphore | null = null;
let _globalMax = 0;

/** Sémaphore global (recréé si LLM_MAX_CONCURRENCY change — utile aux tests). */
export function globalLimiter(): Semaphore {
  const max = maxConcurrency();
  if (!_global || _globalMax !== max) {
    _global = new Semaphore(max);
    _globalMax = max;
  }
  return _global;
}
