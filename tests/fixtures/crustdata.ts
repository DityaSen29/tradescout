/** Test-only stub of the Crustdata API (mock data is permitted for tests). Shapes mirror the documented responses. */
export const company = (id: number, name: string, domain: string | null, desc: string, headcount: number, g6: number, g12: number, founded: number, industries: string[]) => ({
  crustdata_company_id: id,
  basic_info: { name, primary_domain: domain, website: domain ? `https://${domain}` : null, description: desc, year_founded: founded, professional_network_url: `https://www.linkedin.com/company/${id}`, industries },
  locations: { country: "DEU", city: "Hamburg", headquarters: "Hamburg, Germany" },
  headcount: { total: headcount, growth_percent: { "6m": g6, "12m": g12 } },
  taxonomy: { professional_network_industries: industries },
});
export const COMPANIES = [
  company(101, "Nordfaser Technische Textilien GmbH", "nordfaser.de", "Distributor and importer of technical textiles, nonwovens and industrial fabrics for automotive and construction.", 140, 4, 6, 1998, ["Textile Manufacturing", "Wholesale"]),
  company(102, "Nordfaser Handels GmbH", "nordfaser-handel.de", "Trading company for textiles and fabrics.", 25, 0, 1, 2015, ["Wholesale"]),
  company(103, "Rhein Vliesstoffe AG", "rhein-vlies.de", "Nonwovens wholesaler and converter, industrial fabrics.", 900, -10, -35, 1975, ["Textile Manufacturing"]),
  company(104, "Berlin Software Labs", "bsl.dev", "We build SaaS for logistics.", 60, 30, 55, 2019, ["Software Development"]),
  company(105, "Elbe Textil Import", null, "Importer of fabrics and nonwovens.", 40, 2, 3, 2008, ["Import & Export"]),
  company(106, "Nordfaser Technische Textilien GmbH", "nordfaser.de", "Duplicate record with the same domain.", 140, 4, 6, 1998, ["Textile Manufacturing"]),
];
export const ENRICH = {
  companies: COMPANIES.slice(0, 5).filter(c => c.crustdata_company_id !== 105).map(c => ({ ...c, funding: { total_investment_usd: null, last_round_type: null }, news: c.crustdata_company_id === 103 ? [
    { title: "Rhein Vliesstoffe files for insolvency protection", url: "https://example.com/news/rhein-insolvency", date: "2026-10-02" },
    { title: "Rhein Vliesstoffe announces layoffs at Krefeld plant", url: "https://example.com/news/rhein-layoffs", date: "2026-09-14" },
  ] : [] })),
};
export const JOBS = { jobs: [
  { job_id: 9001, job_details: { title: "Senior Purchasing Manager Technical Textiles" }, company: { basic_info: { company_id: 101 } }, metadata: { date_added: "2026-11-01" } },
  { job_id: 9002, job_details: { title: "Sales Engineer" }, company: { basic_info: { company_id: 101 } }, metadata: { date_added: "2026-11-03" } },
  { job_id: 9003, job_details: { title: "Backend Engineer" }, company: { basic_info: { company_id: 104 } }, metadata: { date_added: "2026-10-20" } },
] };
export const PEOPLE = { profiles: [
  { crustdata_person_id: 501, basic_profile: { name: "Anna Weber", headline: "Head of Procurement at Nordfaser", location: { country: "Germany" } }, experience: { employment_details: { current: { title: "Head of Procurement", company_name: "Nordfaser Technische Textilien GmbH", company_id: 101 } } }, basic_info: { professional_network_url: "https://www.linkedin.com/in/anna-weber" } },
  { crustdata_person_id: 502, basic_profile: { name: "Jonas Keller", headline: "Managing Director", location: { country: "Germany" } }, experience: { employment_details: { current: { title: "Managing Director", company_name: "Nordfaser Handels GmbH", company_id: 102 } } }, basic_info: { professional_network_url: "https://www.linkedin.com/in/jonas-keller" } },
] };

/** Install a fetch stub that answers Crustdata endpoints with the fixtures and counts calls per endpoint. */
export function installStub(opts: { failEnrich?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url); const path = u.replace("https://api.crustdata.com", "");
    calls[path] = (calls[path] ?? 0) + 1;
    const reply = (body: unknown, credits: number, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits), "x-ratelimit-remaining": "29" } });
    const req = init?.body ? JSON.parse(init.body) : {};
    if (path === "/company/search") {
      const min = req.filters?.conditions?.find((c: any) => c.type === "=>")?.value ?? 0;
      const rows = COMPANIES.filter(c => c.headcount.total >= min);
      return reply({ companies: rows, total_count: rows.length }, 0.03 * rows.length + 0.4);
    }
    if (path === "/company/enrich") { if (opts.failEnrich) return reply({ error: "boom" }, 0, 500); return reply(ENRICH, 2 * ENRICH.companies.length); }
    if (path === "/job/search") return reply(JOBS, 0.09);
    if (path === "/person/search") return reply(PEOPLE, 0.26);
    if (path === "/account/endpoints") return reply({ endpoints: [] }, 0);
    return reply({ error: `unstubbed ${path}` }, 0, 404);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
