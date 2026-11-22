import { CrmError } from "./adapter.js";

/**
 * Collects the calls made in the same tick into one batch request.
 * The engine writes many leads at once and stays simple; the adapters decide what one request is.
 */
export class Batcher<I, O> {
  private waiting: { item: I; resolve: (v: O) => void; reject: (e: unknown) => void }[] = [];

  /** `run` answers in input order. An Error in place of a value fails that item alone. */
  constructor(private max: number, private run: (items: I[]) => Promise<(O | Error)[]>) {}

  load(item: I): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      this.waiting.push({ item, resolve, reject });
      if (this.waiting.length === 1) setImmediate(() => void this.flush());
    });
  }
  private async flush() {
    const all = this.waiting;
    this.waiting = [];
    for (let i = 0; i < all.length; i += this.max) {
      const part = all.slice(i, i + this.max);
      try {
        const out = await this.run(part.map(p => p.item));
        part.forEach((p, n) => {
          const v = out[n];
          if (v instanceof Error) p.reject(v);
          else if (v === undefined) p.reject(new CrmError(502, "the CRM answered fewer records than were sent"));
          else p.resolve(v);
        });
      } catch (e) { for (const p of part) p.reject(e); }
    }
  }
}

/** One at a time, for when a batch was refused and the bad item must be found. */
export async function eachAlone<I, O>(items: I[], fn: (item: I) => Promise<O>): Promise<(O | Error)[]> {
  const out: (O | Error)[] = [];
  for (const item of items) {
    try { out.push(await fn(item)); }
    catch (e) { out.push(e instanceof Error ? e : new Error(String(e))); }
  }
  return out;
}

/** Starts are spaced by `gapMs` and no more than `width` requests are open at once. */
export class Pace {
  private next = 0;
  private open = 0;
  private queue: (() => void)[] = [];

  constructor(private width: number, private gapMs: number) {}

  async run<T>(fn: () => Promise<T>, weight = 1): Promise<T> {
    if (this.open >= this.width) await new Promise<void>(r => this.queue.push(r));
    else this.open++;
    try {
      const at = Math.max(Date.now(), this.next);
      this.next = at + this.gapMs * weight;
      if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()));
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next(); else this.open--;
    }
  }
}
