import { CrmError, type CrmAdapter, type Kind, type Meter } from "./adapter.js";

/**
 * STUB. Zoho is the second CRM behind the same interface; no Zoho call is implemented.
 * The field map is here so the remaining work is OAuth and the HTTP bodies. Every method fails loudly.
 */
const stub = async (): Promise<never> => { throw new CrmError(501, "Zoho is a stub: not implemented, nothing was sent"); };

export class Zoho implements CrmAdapter {
  readonly name = "zoho";
  readonly idField = "Meridian_Lead_Id";
  readonly ours: Record<Kind, readonly string[]> = { company: ["Account_Name", "Website"], contact: ["First_Name", "Last_Name", "Title", "Email"], deal: ["Deal_Name", "Meridian_Match", "Meridian_Status"] };
  readonly theirs: Record<Kind, readonly string[]> = { company: ["Owner"], contact: ["Owner"], deal: ["Stage", "Owner", "Amount"] };
  constructor(_meter: Meter) {}
  connect = stub; ensureSchema = stub; initialDeal = stub; get = stub; findByExternalId = stub;
  findByNaturalKey = stub; create = stub; update = stub; link = stub; read = stub;
}
