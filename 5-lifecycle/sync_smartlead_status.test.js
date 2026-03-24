import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  STATUS_PRECEDENCE,
  deriveStatus,
  mergeLeadData,
  buildHotLeads,
  buildDeadLeads,
} = require("./sync_smartlead_status");

describe("STATUS_PRECEDENCE", () => {
  it("replied is highest priority", () => {
    expect(STATUS_PRECEDENCE.replied).toBeGreaterThan(STATUS_PRECEDENCE.opened);
    expect(STATUS_PRECEDENCE.replied).toBeGreaterThan(STATUS_PRECEDENCE.unsubscribed);
  });

  it("unsubscribed outranks sent", () => {
    expect(STATUS_PRECEDENCE.unsubscribed).toBeGreaterThan(STATUS_PRECEDENCE.sent);
  });

  it("bounced outranks sent", () => {
    expect(STATUS_PRECEDENCE.bounced).toBeGreaterThan(STATUS_PRECEDENCE.sent);
  });
});

describe("deriveStatus", () => {
  it("returns replied when reply_count > 0", () => {
    expect(deriveStatus({ reply_count: 1, open_count: 5, is_bounced: false, is_unsubscribed: false }))
      .toBe("replied");
  });

  it("returns opened when open_count > 0 but no replies", () => {
    expect(deriveStatus({ reply_count: 0, open_count: 3, is_bounced: false, is_unsubscribed: false }))
      .toBe("opened");
  });

  it("returns bounced when is_bounced is true and no engagement", () => {
    expect(deriveStatus({ reply_count: 0, open_count: 0, is_bounced: true, is_unsubscribed: false }))
      .toBe("bounced");
  });

  it("returns unsubscribed when is_unsubscribed is true", () => {
    expect(deriveStatus({ reply_count: 0, open_count: 0, is_bounced: false, is_unsubscribed: true }))
      .toBe("unsubscribed");
  });

  it("returns sent as default", () => {
    expect(deriveStatus({ reply_count: 0, open_count: 0, is_bounced: false, is_unsubscribed: false }))
      .toBe("sent");
  });

  it("replied beats bounced", () => {
    expect(deriveStatus({ reply_count: 2, open_count: 0, is_bounced: true, is_unsubscribed: false }))
      .toBe("replied");
  });

  it("unsubscribed beats bounced when both are true", () => {
    expect(deriveStatus({ reply_count: 0, open_count: 0, is_bounced: true, is_unsubscribed: true }))
      .toBe("unsubscribed");
  });
});

describe("mergeLeadData", () => {
  it("creates new entry for unseen email", () => {
    const map = new Map();
    mergeLeadData(map, {
      email: "Test@Example.com",
      status: "sent",
      last_email_sent_at: "2026-03-20",
      campaign_id: 123,
    });
    const entry = map.get("test@example.com");
    expect(entry.smartlead_status).toBe("sent");
    expect(entry.last_email_sent_at).toBe("2026-03-20");
  });

  it("higher-precedence status wins on merge", () => {
    const map = new Map();
    mergeLeadData(map, {
      email: "a@b.com",
      status: "sent",
      last_email_sent_at: "2026-03-20",
      campaign_id: 1,
    });
    mergeLeadData(map, {
      email: "a@b.com",
      status: "replied",
      last_replied_at: "2026-03-22",
      reply_text: "Interested!",
      campaign_id: 2,
    });
    const entry = map.get("a@b.com");
    expect(entry.smartlead_status).toBe("replied");
    expect(entry.reply_text).toBe("Interested!");
  });

  it("lower-precedence status does not overwrite", () => {
    const map = new Map();
    mergeLeadData(map, {
      email: "a@b.com",
      status: "replied",
      last_replied_at: "2026-03-22",
      reply_text: "Yes!",
      campaign_id: 1,
    });
    mergeLeadData(map, {
      email: "a@b.com",
      status: "sent",
      last_email_sent_at: "2026-03-23",
      campaign_id: 2,
    });
    const entry = map.get("a@b.com");
    expect(entry.smartlead_status).toBe("replied");
    // But timestamp should be updated if more recent
    expect(entry.last_email_sent_at).toBe("2026-03-23");
  });

  it("keeps most recent timestamps across campaigns", () => {
    const map = new Map();
    mergeLeadData(map, {
      email: "a@b.com",
      status: "opened",
      last_opened_at: "2026-03-18",
      last_email_sent_at: "2026-03-15",
      campaign_id: 1,
    });
    mergeLeadData(map, {
      email: "a@b.com",
      status: "opened",
      last_opened_at: "2026-03-20",
      last_email_sent_at: "2026-03-14",
      campaign_id: 2,
    });
    const entry = map.get("a@b.com");
    expect(entry.last_opened_at).toBe("2026-03-20");
    expect(entry.last_email_sent_at).toBe("2026-03-15");
  });
});

describe("buildHotLeads", () => {
  it("includes only leads with replied status after lastSyncAt", () => {
    const engagementMap = new Map([
      ["a@b.com", {
        smartlead_status: "replied",
        last_replied_at: "2026-03-23T10:00:00Z",
        reply_text: "Yes please!",
      }],
      ["old@b.com", {
        smartlead_status: "replied",
        last_replied_at: "2026-03-20T10:00:00Z",
        reply_text: "Old reply",
      }],
      ["c@d.com", {
        smartlead_status: "opened",
        last_opened_at: "2026-03-23T10:00:00Z",
      }],
    ]);
    const masterRows = [
      { email: "a@b.com", first_name: "Alice", last_name: "Smith", company_name: "Venue A", phone_number: "555-1111" },
      { email: "old@b.com", first_name: "Bob", last_name: "Jones", company_name: "Venue B", phone_number: "555-2222" },
      { email: "c@d.com", first_name: "Carol", last_name: "White", company_name: "Venue C", phone_number: "555-3333" },
    ];
    const lastSyncAt = "2026-03-22T00:00:00Z";

    const hot = buildHotLeads(engagementMap, masterRows, lastSyncAt);
    expect(hot).toHaveLength(1);
    expect(hot[0].Email).toBe("a@b.com");
    expect(hot[0].Phone).toBe("555-1111");
    expect(hot[0].Company).toBe("Venue A");
    expect(hot[0].Notes).toContain("Yes please!");
  });

  it("includes all replied leads when lastSyncAt is null (first run)", () => {
    const engagementMap = new Map([
      ["a@b.com", {
        smartlead_status: "replied",
        last_replied_at: "2026-03-20T10:00:00Z",
        reply_text: "Hi",
      }],
    ]);
    const masterRows = [
      { email: "a@b.com", first_name: "Alice", last_name: "Smith", company_name: "Venue A", phone_number: "555-1111" },
    ];

    const hot = buildHotLeads(engagementMap, masterRows, null);
    expect(hot).toHaveLength(1);
  });
});

describe("buildDeadLeads", () => {
  it("includes bounced and unsubscribed leads", () => {
    const engagementMap = new Map([
      ["a@b.com", { smartlead_status: "bounced", campaign_ids: [123] }],
      ["b@c.com", { smartlead_status: "unsubscribed", campaign_ids: [456] }],
      ["d@e.com", { smartlead_status: "opened", campaign_ids: [123] }],
    ]);
    const masterRows = [
      { email: "a@b.com", company_name: "Venue A", phone_number: "555-1111", website: "a.com" },
      { email: "b@c.com", company_name: "Venue B", phone_number: "555-2222", website: "b.com" },
      { email: "d@e.com", company_name: "Venue C", phone_number: "555-3333", website: "d.com" },
    ];

    const dead = buildDeadLeads(engagementMap, masterRows);
    expect(dead).toHaveLength(2);
    expect(dead.map((d) => d.email)).toEqual(["a@b.com", "b@c.com"]);
  });
});
