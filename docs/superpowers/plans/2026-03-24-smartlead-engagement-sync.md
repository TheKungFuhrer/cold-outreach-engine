# SmartLead Engagement Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily sync pipeline that pulls lead-level engagement data from SmartLead, updates the master CSV, generates hot/dead lead CSVs, and pushes hot leads to GHL.

**Architecture:** Three scripts — `sync_smartlead_status.js` (SmartLead pull + CSV updates), `push_ghl_hot_leads.js` (GHL integration), `daily-sync.js` (cron orchestrator). Two new API methods added to `shared/smartlead.js`. All use existing shared utilities.

**Tech Stack:** Node.js, SmartLead REST API, GHL MCP tools, vitest for tests

**Spec:** `docs/superpowers/specs/2026-03-24-smartlead-engagement-sync-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `shared/smartlead.js` | Add `getCampaignLeads()` and `getLeadMessageHistory()` methods |
| `5-lifecycle/sync-config.json` | Campaign IDs to sync, `sync_all_if_empty` flag |
| `5-lifecycle/sync_smartlead_status.js` | Core sync: pull SmartLead data, merge multi-campaign, update master CSV, write hot/dead CSVs, write JSON report |
| `5-lifecycle/push_ghl_hot_leads.js` | Read hot_leads.csv, find/create GHL contacts, tag, create tasks |
| `scripts/daily-sync.js` | Orchestrate sync + GHL push, print summary |
| `shared/smartlead.test.js` | Tests for new SmartLead API methods |
| `5-lifecycle/sync_smartlead_status.test.js` | Tests for status precedence, merge logic, CSV generation |

---

### Task 1: Add SmartLead API methods

**Files:**
- Modify: `shared/smartlead.js:430-441` (add methods before exports, update exports)
- Create: `shared/smartlead.test.js`

- [ ] **Step 1: Write failing tests for getCampaignLeads and getLeadMessageHistory**

Create `shared/smartlead.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Mock fetch globally before requiring the module
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Stub env to avoid needing real API key
vi.stubEnv("SMARTLEAD_API_KEY", "test-key-123");

const { getCampaignLeads, getLeadMessageHistory } = require("./smartlead");

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getCampaignLeads", () => {
  it("paginates through all leads and returns combined array", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      email: `lead${i}@test.com`,
      sent_count: 1,
    }));
    const page2 = [{ id: 100, email: "lead100@test.com", sent_count: 1 }];

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page1),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page2),
      });

    const result = await getCampaignLeads(12345);
    expect(result).toHaveLength(101);
    expect(result[0].email).toBe("lead0@test.com");
    expect(result[100].email).toBe("lead100@test.com");

    // Verify pagination params in URLs
    const url1 = mockFetch.mock.calls[0][0];
    expect(url1).toContain("/campaigns/12345/leads");
    expect(url1).toContain("offset=0");
    const url2 = mockFetch.mock.calls[1][0];
    expect(url2).toContain("offset=100");
  });

  it("stops pagination when empty array returned", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    });

    const result = await getCampaignLeads(12345);
    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("getLeadMessageHistory", () => {
  it("returns message history for a lead", async () => {
    const messages = [
      { type: "SENT", body: "Hi there", time: "2026-03-20T10:00:00Z" },
      { type: "REPLY", body: "Interested!", time: "2026-03-21T14:00:00Z" },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(messages),
    });

    const result = await getLeadMessageHistory(12345, 99);
    expect(result).toHaveLength(2);
    expect(result[1].body).toBe("Interested!");

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("/campaigns/12345/leads/99/message-history");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/smartlead.test.js`
Expected: FAIL — `getCampaignLeads` and `getLeadMessageHistory` are not exported

- [ ] **Step 3: Implement getCampaignLeads and getLeadMessageHistory**

Add to `shared/smartlead.js` before the exports block (before line 434):

```javascript
// ---------------------------------------------------------------------------
// Lead-level engagement data (for lifecycle sync)
// ---------------------------------------------------------------------------

/**
 * Get all leads for a campaign with per-lead engagement data.
 * Auto-paginates through all results.
 * @param {number} campaignId
 * @param {number} [pageSize=100] - Records per page
 * @returns {Promise<Array<Object>>} All leads with engagement fields
 */
async function getCampaignLeads(campaignId, pageSize = 100) {
  const allLeads = [];
  let offset = 0;
  while (true) {
    const page = await apiRequest(
      "GET",
      `/campaigns/${campaignId}/leads?limit=${pageSize}&offset=${offset}`
    );
    const leads = Array.isArray(page) ? page : page.data || [];
    allLeads.push(...leads);
    if (leads.length < pageSize) break;
    offset += pageSize;
  }
  return allLeads;
}

/**
 * Get message history for a specific lead in a campaign.
 * @param {number} campaignId
 * @param {number} leadId
 * @returns {Promise<Array<Object>>} Message history array
 */
async function getLeadMessageHistory(campaignId, leadId) {
  return apiRequest(
    "GET",
    `/campaigns/${campaignId}/leads/${leadId}/message-history`
  );
}
```

Update the `module.exports` block to include the new methods:

```javascript
module.exports = {
  listCampaigns, getCampaign, getCampaignStats, getCampaignLeadStats, getCampaignEmailAccounts,
  getCampaignLeads, getLeadMessageHistory,
  uploadLeads, addLeadsToCampaign, chunkArray,
  verifyEmails, getVerificationStatus,
  listEmailAccounts, getEmailAccount, updateEmailAccount, getWarmupStats, setWarmup,
  prospectSearch, prospectFindEmails,
  exportCampaignCsv, exportAllLeadsCsv, getLeadCategories,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/smartlead.test.js`
Expected: PASS — both test suites green

- [ ] **Step 5: Commit**

```bash
git add shared/smartlead.js shared/smartlead.test.js
git commit -m "feat: add getCampaignLeads and getLeadMessageHistory to SmartLead client"
```

---

### Task 2: Create sync config

**Files:**
- Create: `5-lifecycle/sync-config.json`

- [ ] **Step 1: Create the config file**

Create `5-lifecycle/sync-config.json`:

```json
{
  "campaign_ids": [3071191, 2434779],
  "sync_all_if_empty": true
}
```

- [ ] **Step 2: Commit**

```bash
git add 5-lifecycle/sync-config.json
git commit -m "chore: add sync-config.json with active campaign IDs"
```

---

### Task 3: Build sync_smartlead_status.js — status merge logic (testable core)

**Files:**
- Create: `5-lifecycle/sync_smartlead_status.js`
- Create: `5-lifecycle/sync_smartlead_status.test.js`

This task implements the pure-logic functions that can be unit tested without API calls: status precedence, multi-campaign merge, CSV generation.

- [ ] **Step 1: Write failing tests for status precedence and merge logic**

Create `5-lifecycle/sync_smartlead_status.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run 5-lifecycle/sync_smartlead_status.test.js`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement the testable core functions**

Create `5-lifecycle/sync_smartlead_status.js`:

```javascript
#!/usr/bin/env node
/**
 * SmartLead Engagement Sync — pulls lead-level status from SmartLead,
 * updates the master CSV, and generates hot_leads.csv + dead_leads.csv.
 *
 * Usage:
 *   node 5-lifecycle/sync_smartlead_status.js [--dry-run]
 */

const { readCsv, writeCsv } = require("../shared/csv");
const { resolveField } = require("../shared/fields");
const { loadJson, saveJson } = require("../shared/progress");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const {
  listCampaigns,
  getCampaignLeads,
  getLeadMessageHistory,
} = require("../shared/smartlead");

// ---------------------------------------------------------------------------
// Status precedence: higher number wins in multi-campaign merge
// ---------------------------------------------------------------------------

const STATUS_PRECEDENCE = {
  sent: 1,
  bounced: 2,
  unsubscribed: 3,
  opened: 4,
  replied: 5,
};

/**
 * Derive a single status string from a SmartLead lead record's fields.
 * @param {Object} lead - Lead object with reply_count, open_count, is_bounced, is_unsubscribed
 * @returns {string} One of: replied, opened, unsubscribed, bounced, sent
 */
function deriveStatus(lead) {
  if (lead.reply_count > 0) return "replied";
  if (lead.open_count > 0) return "opened";
  if (lead.is_unsubscribed) return "unsubscribed";
  if (lead.is_bounced) return "bounced";
  return "sent";
}

/**
 * Merge a lead's engagement data into the map, applying status precedence.
 * @param {Map} map - Map<email, engagementData>
 * @param {Object} data - { email, status, last_email_sent_at, last_opened_at, last_replied_at, reply_text, campaign_id }
 */
function mergeLeadData(map, data) {
  const email = data.email.toLowerCase();
  const existing = map.get(email);

  if (!existing) {
    map.set(email, {
      smartlead_status: data.status,
      last_email_sent_at: data.last_email_sent_at || "",
      last_opened_at: data.last_opened_at || "",
      last_replied_at: data.last_replied_at || "",
      reply_text: data.reply_text || "",
      campaign_ids: [data.campaign_id],
    });
    return;
  }

  // Merge status: higher precedence wins
  if (
    (STATUS_PRECEDENCE[data.status] || 0) >
    (STATUS_PRECEDENCE[existing.smartlead_status] || 0)
  ) {
    existing.smartlead_status = data.status;
  }

  // Keep most recent timestamps
  const tsFields = ["last_email_sent_at", "last_opened_at", "last_replied_at"];
  for (const field of tsFields) {
    if (data[field] && (!existing[field] || data[field] > existing[field])) {
      existing[field] = data[field];
    }
  }

  // Concatenate reply text if new
  if (data.reply_text && !existing.reply_text.includes(data.reply_text)) {
    existing.reply_text = existing.reply_text
      ? `${existing.reply_text}\n---\n${data.reply_text}`
      : data.reply_text;
  }

  // Track campaign IDs
  if (!existing.campaign_ids.includes(data.campaign_id)) {
    existing.campaign_ids.push(data.campaign_id);
  }
}

/**
 * Build hot leads array (Wavv format) from engagement data.
 * Only includes leads who replied after lastSyncAt.
 * @param {Map} engagementMap
 * @param {Array} masterRows - Master CSV records
 * @param {string|null} lastSyncAt - ISO timestamp of last sync, or null for first run
 * @returns {Array<Object>} Wavv-formatted rows: Phone, First Name, Last Name, Company, Notes
 */
function buildHotLeads(engagementMap, masterRows, lastSyncAt) {
  const hot = [];
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    if (!email) continue;
    const engagement = engagementMap.get(email);
    if (!engagement || engagement.smartlead_status !== "replied") continue;
    if (lastSyncAt && engagement.last_replied_at <= lastSyncAt) continue;

    hot.push({
      Email: email,
      Phone: resolveField(row, "phone"),
      "First Name": resolveField(row, "firstName"),
      "Last Name": resolveField(row, "lastName"),
      Company: resolveField(row, "companyName"),
      Notes: (engagement.reply_text || "").slice(0, 500),
    });
  }
  return hot;
}

/**
 * Build dead leads array from engagement data.
 * Includes all bounced and unsubscribed leads.
 * @param {Map} engagementMap
 * @param {Array} masterRows - Master CSV records
 * @returns {Array<Object>} Dead lead rows
 */
function buildDeadLeads(engagementMap, masterRows) {
  const dead = [];
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    if (!email) continue;
    const engagement = engagementMap.get(email);
    if (!engagement) continue;
    if (
      engagement.smartlead_status !== "bounced" &&
      engagement.smartlead_status !== "unsubscribed"
    )
      continue;

    dead.push({
      email,
      company_name: resolveField(row, "companyName"),
      phone_number: resolveField(row, "phone"),
      website: resolveField(row, "website"),
      smartlead_status: engagement.smartlead_status,
      campaign_id: (engagement.campaign_ids || []).join(";"),
    });
  }
  return dead;
}

// ---------------------------------------------------------------------------
// Main sync logic (called when script is run directly)
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // Load config
  const config = loadJson(projectPath("5-lifecycle", "sync-config.json")) || {
    campaign_ids: [],
    sync_all_if_empty: true,
  };

  // Determine campaigns to sync
  let campaignIds = config.campaign_ids || [];
  if (campaignIds.length === 0 && config.sync_all_if_empty) {
    const allCampaigns = await listCampaigns();
    campaignIds = allCampaigns.map((c) => c.id);
  }
  console.log(`Syncing ${campaignIds.length} campaigns: ${campaignIds.join(", ")}`);

  // Load checkpoint
  const checkpointPath = projectPath("data", "lifecycle", ".sync_checkpoint.json");
  const checkpoint = loadJson(checkpointPath) || {};
  const lastSyncAt = checkpoint.last_sync_at || null;

  // Pull lead-level data from each campaign
  const engagementMap = new Map();
  const totals = { sent: 0, opened: 0, replied: 0, bounced: 0, unsubscribed: 0 };

  for (const campaignId of campaignIds) {
    console.log(`  Pulling leads for campaign ${campaignId}...`);
    const leads = await getCampaignLeads(campaignId);
    console.log(`    ${leads.length} leads`);

    for (const lead of leads) {
      const email = (lead.email || "").toLowerCase();
      if (!email) continue;

      const status = deriveStatus(lead);
      totals[status] = (totals[status] || 0) + 1;

      let replyText = "";
      let lastRepliedAt = lead.last_replied_at || "";

      // Fetch message history for new replies only
      if (
        lead.reply_count > 0 &&
        (!lastSyncAt || !lastRepliedAt || lastRepliedAt > lastSyncAt)
      ) {
        try {
          const messages = await getLeadMessageHistory(campaignId, lead.id);
          const replies = Array.isArray(messages)
            ? messages.filter((m) => m.type === "REPLY" || m.type === "reply")
            : [];
          if (replies.length > 0) {
            replyText = replies[replies.length - 1].body || "";
            lastRepliedAt = replies[replies.length - 1].time || lastRepliedAt;
          }
        } catch (err) {
          console.warn(`    Warning: could not fetch messages for lead ${lead.id}: ${err.message}`);
        }
      }

      mergeLeadData(engagementMap, {
        email,
        status,
        last_email_sent_at: lead.last_email_sent_at || "",
        last_opened_at: lead.last_opened_at || "",
        last_replied_at: lastRepliedAt,
        reply_text: replyText,
        campaign_id: campaignId,
      });
    }
  }

  // Save raw snapshot
  const ts = timestamp();
  ensureDir(projectPath("data", "lifecycle"));
  saveJson(projectPath("data", "lifecycle", `smartlead_sync_${ts}.json`), {
    generated_at: new Date().toISOString(),
    campaigns_synced: campaignIds,
    totals,
    leads: Object.fromEntries(engagementMap),
  });

  // Load master CSV
  const masterPath = projectPath("data", "upload", "master_enriched_emails.csv");
  const { records: masterRows, columns: masterCols } = readCsv(masterPath);
  console.log(`  Master CSV: ${masterRows.length} rows`);

  // Engagement columns to add/overwrite
  const engagementCols = [
    "smartlead_status",
    "last_email_sent_at",
    "last_opened_at",
    "last_replied_at",
    "reply_text",
  ];

  // Update master rows with engagement data
  for (const row of masterRows) {
    const email = resolveField(row, "email").toLowerCase();
    const engagement = engagementMap.get(email);
    if (engagement) {
      row.smartlead_status = engagement.smartlead_status;
      row.last_email_sent_at = engagement.last_email_sent_at;
      row.last_opened_at = engagement.last_opened_at;
      row.last_replied_at = engagement.last_replied_at;
      row.reply_text = (engagement.reply_text || "").slice(0, 500);
    } else {
      for (const col of engagementCols) {
        if (!row[col]) row[col] = "";
      }
    }
  }

  // Ensure engagement columns appear in output
  const outputCols = [...new Set([...masterCols, ...engagementCols])];

  // Build hot and dead lead CSVs
  const hotLeads = buildHotLeads(engagementMap, masterRows, lastSyncAt);
  const deadLeads = buildDeadLeads(engagementMap, masterRows);

  if (dryRun) {
    console.log("\n[DRY RUN] Would write:");
    console.log(`  Master CSV: ${masterRows.length} rows with engagement columns`);
    console.log(`  Hot leads: ${hotLeads.length}`);
    console.log(`  Dead leads: ${deadLeads.length}`);
  } else {
    // Write updated master
    writeCsv(masterPath, masterRows, outputCols);

    // Write hot leads
    const hotPath = projectPath("data", "lifecycle", "hot_leads.csv");
    writeCsv(hotPath, hotLeads);
    console.log(`  Hot leads written: ${hotLeads.length} → ${hotPath}`);

    // Write dead leads
    const deadPath = projectPath("data", "lifecycle", "dead_leads.csv");
    writeCsv(deadPath, deadLeads);
    console.log(`  Dead leads written: ${deadLeads.length} → ${deadPath}`);

    // Update checkpoint
    saveJson(checkpointPath, { last_sync_at: new Date().toISOString() });
  }

  // Write JSON report
  const report = {
    generated_at: new Date().toISOString(),
    campaigns_synced: campaignIds,
    totals,
    new_replies: hotLeads.length,
    hot_leads: hotLeads.map((h) => h.Email),
    dead_leads_count: deadLeads.length,
  };
  const reportPath = projectPath("data", "reports", `smartlead_sync_${ts}.json`);
  ensureDir(projectPath("data", "reports"));
  saveJson(reportPath, report);

  // Console summary
  console.log(`\nSmartLead Sync Complete — ${new Date().toISOString().slice(0, 10)}`);
  console.log(
    `Today: ${totals.sent} sent, ${totals.opened} opened, ` +
      `${totals.replied} replied, ${totals.bounced} bounced, ${totals.unsubscribed} unsubscribed`
  );
  console.log(`New hot leads for Bryce: ${hotLeads.length}`);
  for (const h of hotLeads) {
    const snippet = h.Notes ? `"${h.Notes.slice(0, 60)}..."` : "";
    const phone = h.Phone ? ` (${h.Phone})` : "";
    console.log(`  - ${h.Company || h.Email}${phone} — ${snippet}`);
  }
  console.log(`Dead leads excluded: ${deadLeads.length}`);

  return { report, hotLeads, deadLeads };
}

// Run if called directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}

module.exports = {
  STATUS_PRECEDENCE,
  deriveStatus,
  mergeLeadData,
  buildHotLeads,
  buildDeadLeads,
  main,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run 5-lifecycle/sync_smartlead_status.test.js`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add 5-lifecycle/sync_smartlead_status.js 5-lifecycle/sync_smartlead_status.test.js
git commit -m "feat: add sync_smartlead_status.js with status merge logic and tests"
```

---

### Task 4: Build push_ghl_hot_leads.js

**Files:**
- Create: `5-lifecycle/push_ghl_hot_leads.js`

This script reads `hot_leads.csv` and uses GHL MCP tools to tag contacts and create tasks. Since MCP tools are external and not easily unit-testable, this task focuses on the script implementation with `--dry-run` support.

- [ ] **Step 1: Implement push_ghl_hot_leads.js**

Create `5-lifecycle/push_ghl_hot_leads.js`:

```javascript
#!/usr/bin/env node
/**
 * Push hot leads to GHL — tags contacts and creates callback tasks for Bryce.
 *
 * Reads hot_leads.csv (Wavv format), finds or creates contacts in GHL,
 * adds tags, and creates tasks.
 *
 * Usage:
 *   node 5-lifecycle/push_ghl_hot_leads.js [--input <csv>] [--dry-run]
 *
 * NOTE: This script uses GHL MCP tools which must be available in the
 * Claude Code environment. When run standalone (e.g., via cron), GHL
 * operations are skipped and a warning is printed. Use --dry-run to
 * preview actions.
 */

const { readCsv } = require("../shared/csv");
const { projectPath } = require("../shared/utils");

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = (flag) => args.indexOf(flag);
  return {
    input:
      idx("--input") !== -1
        ? args[idx("--input") + 1]
        : projectPath("data", "lifecycle", "hot_leads.csv"),
    dryRun: args.includes("--dry-run"),
  };
}

/**
 * Process a single hot lead through GHL.
 * @param {Object} lead - Hot lead row (Email, Phone, First Name, Last Name, Company, Notes)
 * @param {Object} ghl - Object with GHL MCP functions
 * @param {boolean} dryRun
 * @returns {Object} { success: boolean, action: string, error?: string }
 */
async function processLead(lead, ghl, dryRun) {
  const email = lead.Email || "";
  const phone = lead.Phone || "";
  const firstName = lead["First Name"] || "";
  const lastName = lead["Last Name"] || "";
  const company = lead.Company || "";
  const notes = lead.Notes || "";

  if (dryRun) {
    console.log(`  [DRY RUN] Would process: ${company} (${phone})`);
    console.log(`    - Search/create contact by email: ${email}`);
    console.log(`    - Add tags: hot_lead, smartlead_replied`);
    console.log(`    - Create task: "Call back: ${company}"`);
    return { success: true, action: "dry_run" };
  }

  try {
    // Step 1: Search for existing contact
    let contactId = null;
    const searchResult = await ghl.searchContacts({ query: email });
    if (searchResult && searchResult.contacts && searchResult.contacts.length > 0) {
      contactId = searchResult.contacts[0].id;
    }

    // Step 2: Create contact if not found
    if (!contactId) {
      const created = await ghl.createContact({
        email,
        phone,
        firstName,
        lastName,
        companyName: company,
      });
      contactId = created.contact ? created.contact.id : null;
    }

    if (!contactId) {
      return { success: false, action: "no_contact_id", error: "Could not find or create contact" };
    }

    // Step 3: Add tags
    await ghl.addContactTags(contactId, { tags: ["hot_lead", "smartlead_replied"] });

    // Step 4: Check for existing task (idempotency)
    const taskTitle = `Call back: ${company}`;
    const existingTasks = await ghl.getContactTasks(contactId);
    const hasDuplicateTask =
      existingTasks &&
      existingTasks.tasks &&
      existingTasks.tasks.some(
        (t) => t.title === taskTitle && t.status !== "completed"
      );

    if (hasDuplicateTask) {
      console.log(`  Skipped task (duplicate): ${taskTitle}`);
      return { success: true, action: "tagged_only" };
    }

    // Step 5: Create task
    await ghl.createContactTask(contactId, {
      title: taskTitle,
      description: notes,
      dueDate: new Date().toISOString().slice(0, 10),
      status: "pending",
    });

    console.log(`  Processed: ${company} (${phone}) — tagged + task created`);
    return { success: true, action: "tagged_and_tasked" };
  } catch (err) {
    console.error(`  Error processing ${company}: ${err.message}`);
    return { success: false, action: "error", error: err.message };
  }
}

async function main() {
  const { input, dryRun } = parseArgs();
  const { records } = readCsv(input);

  if (records.length === 0) {
    console.log("No hot leads to push to GHL.");
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`Pushing ${records.length} hot leads to GHL${dryRun ? " [DRY RUN]" : ""}...`);

  // GHL MCP tool wrappers — these will be replaced with actual MCP calls
  // during integration. For now, the structure is defined.
  const ghl = {
    searchContacts: async (params) => {
      // MCP: mcp__ghl__search_contacts
      throw new Error("GHL MCP not available in standalone mode. Use --dry-run or run within Claude Code.");
    },
    createContact: async (params) => {
      // MCP: mcp__ghl__create_contact
      throw new Error("GHL MCP not available in standalone mode.");
    },
    addContactTags: async (contactId, params) => {
      // MCP: mcp__ghl__add_contact_tags
      throw new Error("GHL MCP not available in standalone mode.");
    },
    getContactTasks: async (contactId) => {
      // MCP: mcp__ghl__get_contact_tasks
      throw new Error("GHL MCP not available in standalone mode.");
    },
    createContactTask: async (contactId, params) => {
      // MCP: mcp__ghl__create_contact_task
      throw new Error("GHL MCP not available in standalone mode.");
    },
  };

  let succeeded = 0;
  let failed = 0;

  for (const lead of records) {
    const result = await processLead(lead, ghl, dryRun);
    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  console.log(`\nGHL Push Complete: ${succeeded} succeeded, ${failed} failed out of ${records.length}`);
  return { processed: records.length, succeeded, failed };
}

if (require.main === module) {
  main().catch((err) => {
    console.error("GHL push failed:", err);
    process.exit(1);
  });
}

module.exports = { processLead, main };
```

- [ ] **Step 2: Verify it loads and --dry-run works**

Run: `node 5-lifecycle/push_ghl_hot_leads.js --dry-run`
Expected: "No hot leads to push to GHL." (since hot_leads.csv doesn't exist yet)

- [ ] **Step 3: Commit**

```bash
git add 5-lifecycle/push_ghl_hot_leads.js
git commit -m "feat: add push_ghl_hot_leads.js for GHL contact tagging and task creation"
```

---

### Task 5: Build daily-sync.js orchestrator

**Files:**
- Create: `scripts/daily-sync.js`

- [ ] **Step 1: Implement daily-sync.js**

Create `scripts/daily-sync.js`:

```javascript
#!/usr/bin/env node
/**
 * Daily Engagement Sync — orchestrates SmartLead status sync + GHL push.
 *
 * Cron: 0 8 * * * (8 AM daily)
 *
 * Usage:
 *   node scripts/daily-sync.js [--dry-run]
 */

const path = require("path");
const { readCsv } = require("../shared/csv");
const { projectPath } = require("../shared/utils");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log(`=== Daily Engagement Sync — ${new Date().toISOString().slice(0, 10)} ===`);
  if (dryRun) console.log("[DRY RUN MODE]\n");

  // Step 1: Run SmartLead sync
  console.log("Step 1: Syncing SmartLead engagement data...\n");
  const sync = require("../5-lifecycle/sync_smartlead_status");
  const { report, hotLeads } = await sync.main();

  // Step 2: Push hot leads to GHL if any exist
  if (hotLeads && hotLeads.length > 0) {
    console.log("\nStep 2: Pushing hot leads to GHL...\n");
    const ghlPush = require("../5-lifecycle/push_ghl_hot_leads");
    await ghlPush.main();
  } else {
    console.log("\nStep 2: No hot leads — skipping GHL push.");
  }

  console.log("\n=== Daily Sync Complete ===");
}

main().catch((err) => {
  console.error("\nDaily sync failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it loads without errors**

Run: `node scripts/daily-sync.js --dry-run 2>&1 | head -5`
Expected: Prints the header and starts sync (will fail on SmartLead API call since no real key, but the script structure loads correctly)

- [ ] **Step 3: Commit**

```bash
git add scripts/daily-sync.js
git commit -m "feat: add daily-sync.js orchestrator for cron-based engagement sync"
```

---

### Task 6: Integration test with --dry-run

**Files:**
- None new — verify the end-to-end flow

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass (smartlead.test.js, sync_smartlead_status.test.js, fields.test.js, build-master.test.js)

- [ ] **Step 2: Verify --dry-run flag propagates correctly**

Run: `node 5-lifecycle/sync_smartlead_status.js --dry-run 2>&1 | head -20`
Expected: Script loads config, attempts to pull from SmartLead (will error on API in test, but shows the flow is wired up)

- [ ] **Step 3: Final commit with all files**

Verify no uncommitted changes:

```bash
git status
```

If clean, done. If any stragglers, add and commit:

```bash
git add -A && git commit -m "chore: ensure all engagement sync files committed"
```
