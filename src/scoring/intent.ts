export interface IntentInput { open_jobs_total: number | null; buying_roles_open: number | null; growth_6m: number | null; news_recent: number | null }
export interface Intent { score: number; tags: string[] }
/** Buyer-intent signals: is this counterparty actively buying or expanding right now? 0 to 1. */
export function scoreIntent(i: IntentInput): Intent {
  const tags: string[] = []; let s = 0;
  if ((i.buying_roles_open ?? 0) > 0) { s += 0.5; tags.push(`hiring ${i.buying_roles_open} buying/sourcing roles`); }
  if ((i.open_jobs_total ?? 0) >= 5) { s += 0.2; tags.push(`${i.open_jobs_total} open roles`); }
  if ((i.growth_6m ?? 0) >= 5) { s += 0.3; tags.push(`headcount +${i.growth_6m!.toFixed(0)}% in 6 months`); }
  else if ((i.growth_6m ?? 0) > 0) { s += 0.15; tags.push("headcount growing"); }
  if ((i.news_recent ?? 0) > 0) { s += 0.1; tags.push("recent news coverage"); }
  return { score: Math.min(1, s), tags };
}
