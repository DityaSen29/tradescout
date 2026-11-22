/** Failures from before a byte of the request left this machine. Only these are safe to retry on a paid call. */
const NEVER_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
export function neverSent(err: any): boolean {
  if (NEVER_SENT.has(err?.cause?.code)) return true;
  const all: any[] = err?.cause?.errors ?? [];      // happy-eyeballs gives one error per address
  return all.length > 0 && all.every(e => NEVER_SENT.has(e.code) || (e.code === "ETIMEDOUT" && e.syscall === "connect"));
}

/** fetch with retries for connection failures only. A timeout after connecting is never repeated. */
export async function fetchOnce(url: string, init: () => RequestInit, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    try { return await fetch(url, init()); }
    catch (err) {
      if (i >= tries - 1 || !neverSent(err)) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
}
