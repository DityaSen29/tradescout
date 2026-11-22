import type { Ledger } from "../ledger/ledger.js";
import { draftHash, type Outreach } from "./engine.js";

/** Invented leads on reserved domains, only ever seeded into the simulation database. */
export function seedDemo(ledger: Ledger, engine: Outreach) {
  if (!engine.simulated) throw new Error("demo leads are for simulation only");
  if (engine.usableMailboxes().length) return;
  const mailbox = "sales@exporter.example";
  engine.s.saveMailbox(mailbox, "simulated", null);
  engine.s.campaign("example-exporter");
  engine.s.run("UPDATE outreach_campaigns SET mailbox=?, booking_url=? WHERE client_id=?", mailbox, "https://example.com/book", "example-exporter");
  engine.setFacts("example-exporter", [
    "We supply woven polyester filter fabric in widths up to 2.2 metres.",
    "Samples ship from India within five working days.",
    "Minimum order is 500 metres per specification.",
    "Each batch comes with a test certificate for weight and air permeability.",
  ]);
  const run = ledger.createRun({ product: "industrial filter fabric", target_country: "DEU", min_headcount: 20, max_headcount: 2000 });
  [["Anna", "Nordfilter Example GmbH", "nordfilter"], ["Jonas", "Rheintex Example AG", "rheintex"], ["Mara", "Elbe Process Example", "elbe"]].forEach(([name, company, slug], i) => {
    const to = `${name.toLowerCase()}@${slug}.example`;
    const subject = `Filter fabric for ${company}`;
    const body = `Hi ${name},\n\nWe make industrial filter fabric in India. Would it be useful to compare a sample with what you use today?`;
    ledger.proposeAction(run, "email_draft", `demo:${slug}`, {
      lead_id: `demo-${i}`, client_id: "example-exporter", run_id: run, step: 1, to_name: name, to_title: "Purchasing manager",
      to_email: to, to_email_status: "deliverable", company, subject, body, sentences: [],
      draft_hash: draftHash(subject, body), dedupe_key: `example-exporter:demo-${i}:${to}:1`, based_on: [],
    });
  });
}

/** Example records for the invented domain: a typical new sender, with DMARC still at p=none. */
export async function simulatedDns(name: string): Promise<string[]> {
  if (name === "exporter.example") return ["v=spf1 include:_spf.google.com ~all"];
  if (name === "_spf.google.com") return ["v=spf1 ip4:192.0.2.0/24 ~all"];
  if (name === "google._domainkey.exporter.example") return ["v=DKIM1; k=rsa; p=EXAMPLEKEY"];
  if (name === "_dmarc.exporter.example") return ["v=DMARC1; p=none"];
  return [];
}
