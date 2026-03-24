# SmartLead API Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all SmartLead API interactions (REST + CLI) into `shared/smartlead.js` so no other script calls the API or CLI directly.

**Architecture:** Extend the existing flat module with ~12 new exported functions (email accounts, campaign email-account mapping, CLI wrappers), add opt-in debug logging via `SMARTLEAD_DEBUG` env var, add JSDoc to every export. Refactor 5 files that bypass the module. Remove `apiRequest` from exports. Note: `getCampaignStats` already calls `/analytics` (not `/stats`), so no separate `getCampaignAnalytics` is needed.

**Tech Stack:** Node.js, SmartLead REST API, SmartLead CLI (`smartlead` npm package)

**Spec:** `docs/superpowers/specs/2026-03-24-smartlead-api-consolidation-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `shared/smartlead.js` | Modify | Add debug logging, CLI helpers, 12 new functions, JSDoc, remove internals from exports |
| `4-analytics/mailbox_audit.js` | Modify | Replace 5 local `apiRequest()` wrappers with shared imports |
| `4-analytics/configure_new_mailboxes.js` | Modify | Replace 4 inline `apiRequest()` calls with shared imports |
| `1-prospecting/pull_leads.js` | Modify | Replace 3 CLI `execSync` calls with shared wrappers |
| `3-outreach/prospect_emails.js` | Modify | Replace `execSync` find-emails CLI call with shared `prospectFindEmails` |
| `scripts/daily-prospect.js` | Modify | Replace 3 CLI `execSync` calls with shared wrappers, rename local function |

---

### Task 1: Add debug logging and internal CLI helpers to shared/smartlead.js

**Files:**
- Modify: `shared/smartlead.js:1-16` (add requires, debug flag)
- Modify: `shared/smartlead.js:47-91` (add debug logging to apiRequest)

- [ ] **Step 1: Add `execSync` require and debug infrastructure at top of file**

Add after line 1 (`const { requireEnv } = require("./env");`):

```javascript
const { execSync } = require("child_process");

// --- Debug logging (opt-in via SMARTLEAD_DEBUG env var) ---
const DEBUG = process.env.SMARTLEAD_DEBUG || "";
function debugLog(msg) {
  if (DEBUG) process.stderr.write(`[SmartLead] ${msg}\n`);
}
function debugVerbose(msg) {
  if (DEBUG === "verbose") process.stderr.write(`[SmartLead] ${msg}\n`);
}
```

- [ ] **Step 2: Add debug logging to `apiRequest`**

After `const res = await fetch(url, options);` (inside the for loop, after the response is received), add timing and debug output. Wrap the existing fetch in timing:

Add `const start = Date.now();` before the `for` loop (line 63).
After `const text = await res.text();` add:
```javascript
debugLog(`${method} ${path} → ${res.status} (${Date.now() - start}ms)`);
debugVerbose(`Response: ${text.slice(0, 500)}`);
```

- [ ] **Step 3: Add `runCLI` and `parseCLIOutput` internal helpers**

Add before the "Campaign operations" section (before line 93):

```javascript
// ---------------------------------------------------------------------------
// CLI helpers (internal)
// ---------------------------------------------------------------------------

function runCLI(args, { timeout = 60000, maxBuffer = 50 * 1024 * 1024 } = {}) {
  const apiKey = getApiKey();
  const cmd = `smartlead --api-key "${apiKey}" ${args}`;
  const start = Date.now();
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout,
      maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
    });
    debugLog(`CLI: ${args} → OK (${Date.now() - start}ms)`);
    return output;
  } catch (err) {
    debugLog(`CLI: ${args} → ERROR (${Date.now() - start}ms): ${err.message.split("\n")[0]}`);
    return null;
  }
}

function parseCLIOutput(output) {
  if (!output) return [];
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const jsonStart = trimmed.indexOf("[") !== -1
      ? trimmed.indexOf("[")
      : trimmed.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(trimmed.slice(jsonStart));
    if (Array.isArray(parsed)) return parsed;
    return parsed.data || parsed.results || [parsed];
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Verify module still loads**

Run: `node -e "require('./shared/smartlead'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add shared/smartlead.js
git commit -m "feat(smartlead): add debug logging and CLI helpers"
```

---

### Task 2: Add new REST API functions to shared/smartlead.js

**Files:**
- Modify: `shared/smartlead.js` (add 7 new functions after existing sections)

- [ ] **Step 1: Add `getCampaignEmailAccounts`**

Note: `getCampaignAnalytics` is NOT needed — `getCampaignStats` already calls `/campaigns/{id}/analytics`. The existing function serves both purposes. `mailbox_audit.js` will import `getCampaignStats` instead.

Add after the existing `getCampaignStats` function:

```javascript
/**
 * Get email accounts assigned to a campaign.
 * @param {string|number} campaignId - Campaign ID
 * @returns {Promise<Array<Object>>} Array of email account objects
 */
async function getCampaignEmailAccounts(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/email-accounts`);
}
```

- [ ] **Step 2: Add Email Accounts group (5 functions)**

Add after the Email Verification section:

```javascript
// ---------------------------------------------------------------------------
// Email account management
// ---------------------------------------------------------------------------

/**
 * List all email accounts connected to SmartLead.
 * @returns {Promise<Array<Object>>} Array of email account objects
 */
async function listEmailAccounts() {
  return apiRequest("GET", "/email-accounts");
}

/**
 * Get a single email account by ID.
 * @param {string|number} accountId - Email account ID
 * @returns {Promise<Object>} Email account details
 */
async function getEmailAccount(accountId) {
  return apiRequest("GET", `/email-accounts/${accountId}`);
}

/**
 * Update email account settings (daily limit, signature, etc.).
 * SmartLead uses POST (not PATCH) for account updates.
 * @param {string|number} accountId - Email account ID
 * @param {Object} config - Settings to update (max_email_per_day, signature, from_name, etc.)
 * @returns {Promise<Object>} Updated account object
 */
async function updateEmailAccount(accountId, config) {
  return apiRequest("POST", `/email-accounts/${accountId}`, config);
}

/**
 * Get warmup statistics for an email account.
 * @param {string|number} accountId - Email account ID
 * @returns {Promise<Object>} Warmup stats (sent_count, spam_count, inbox_count, stats_by_date)
 */
async function getWarmupStats(accountId) {
  return apiRequest("GET", `/email-accounts/${accountId}/warmup-stats`);
}

/**
 * Enable or disable warmup for an email account.
 * @param {string|number} accountId - Email account ID
 * @param {boolean} enabled - Whether to enable warmup
 * @returns {Promise<Object>} API response
 */
async function setWarmup(accountId, enabled) {
  return apiRequest("POST", `/email-accounts/${accountId}/warmup`, {
    warmup_enabled: enabled,
  });
}
```

- [ ] **Step 3: Verify module loads with new functions**

Run: `node -e "const sl = require('./shared/smartlead'); console.log(typeof sl.listEmailAccounts, typeof sl.getWarmupStats)"` — but wait, we haven't exported yet. Just verify no syntax errors:

Run: `node -c shared/smartlead.js`
Expected: No output (success)

- [ ] **Step 4: Commit**

```bash
git add shared/smartlead.js
git commit -m "feat(smartlead): add email account and campaign analytics functions"
```

---

### Task 3: Add CLI wrapper functions to shared/smartlead.js

**Files:**
- Modify: `shared/smartlead.js` (add 5 CLI wrapper functions)

- [ ] **Step 1: Add Prospect CLI wrappers**

Add after the Email Accounts section:

```javascript
// ---------------------------------------------------------------------------
// Prospect (CLI wrappers)
// ---------------------------------------------------------------------------

/**
 * Search for prospects matching a query via SmartLead CLI.
 * @param {string} query - Search query (e.g. "wedding venue TX")
 * @returns {Array<Object>} Prospect results, or [] on failure
 * @note Never throws — returns empty array on CLI failure
 */
function prospectSearch(query) {
  const output = runCLI(`prospect search --query "${query}"`);
  return parseCLIOutput(output) || [];
}

/**
 * Find email addresses for a domain via SmartLead CLI.
 * Writes a temp JSON file for the CLI --from-json flag.
 * @param {string} domain - Company domain (e.g. "acme.com")
 * @param {Object} [contact={}] - Optional contact info {firstName, lastName}
 * @returns {{emails: string[], raw: Object|null, error: string|null}}
 * @note Never throws — returns {emails: [], error: message} on failure
 */
function prospectFindEmails(domain, contact = {}) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpFile = path.join(os.tmpdir(), `sl_find_emails_${Date.now()}.json`);
  const payload = {
    contacts: [{
      firstName: contact.firstName || "",
      lastName: contact.lastName || "",
      companyDomain: domain,
    }],
  };

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    const output = runCLI(`prospect find-emails --from-json "${tmpFile}"`);
    try { fs.unlinkSync(tmpFile); } catch {}

    if (!output) return { emails: [], raw: null, error: "CLI returned no output" };

    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) return { emails: [], raw: null, error: "No JSON in output" };

    const parsed = JSON.parse(output.slice(jsonStart));
    const data = parsed.data || [];
    const emails = data
      .filter((r) => r.email_id && r.status !== "Not Found")
      .map((r) => r.email_id);
    return { emails, raw: parsed, error: null };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    return { emails: [], raw: null, error: err.message.split("\n")[0] };
  }
}
```

- [ ] **Step 2: Add Data Export CLI wrappers**

Add after the Prospect section:

```javascript
// ---------------------------------------------------------------------------
// Data export (CLI wrappers)
// ---------------------------------------------------------------------------

/**
 * Export campaign leads to a CSV file via SmartLead CLI.
 * @param {string|number} campaignId - Campaign ID
 * @param {string} outPath - Absolute path for the output CSV file
 * @returns {boolean} true if export succeeded, false on failure
 * @note Never throws — returns false on CLI failure
 */
function exportCampaignCsv(campaignId, outPath) {
  const output = runCLI(
    `campaigns export --id ${campaignId} --out "${outPath}"`,
    { timeout: 120000 }
  );
  return output !== null;
}

/**
 * Export all leads across all campaigns as CSV via SmartLead CLI.
 * @returns {string|null} CSV string, or null on failure
 * @note Never throws — returns null on CLI failure
 */
function exportAllLeadsCsv() {
  return runCLI("leads list-all --all --format csv", { timeout: 120000 });
}

/**
 * Get available lead categories from SmartLead.
 * @returns {Array|null} Parsed categories, or null on failure
 * @note Never throws — returns null on CLI failure
 */
function getLeadCategories() {
  const output = runCLI("leads categories --format json");
  return parseCLIOutput(output);
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c shared/smartlead.js`
Expected: No output (success)

- [ ] **Step 4: Commit**

```bash
git add shared/smartlead.js
git commit -m "feat(smartlead): add CLI wrappers for prospect search, find-emails, and data export"
```

---

### Task 4: Update exports and add JSDoc to existing functions

**Files:**
- Modify: `shared/smartlead.js:175-189` (exports) and existing function headers

- [ ] **Step 1: Add JSDoc to existing functions that lack it**

Add JSDoc comments to `listCampaigns`, `getCampaign`, `getCampaignLeadStats`, `getCampaignStats`, `verifyEmails`, `getVerificationStatus`, `chunkArray`. Example for `listCampaigns`:

```javascript
/**
 * List all campaigns.
 * @returns {Promise<Array<Object>>} Array of campaign objects
 */
async function listCampaigns() {
```

And for `chunkArray`:
```javascript
/**
 * Split an array into chunks of a given size. Used for batch uploads (max 400).
 * @param {Array} arr - Array to chunk
 * @param {number} [size=400] - Chunk size
 * @returns {Array<Array>} Array of chunks
 */
function chunkArray(arr, size = 400) {
```

- [ ] **Step 2: Replace module.exports with new list (remove internals)**

Replace the entire `module.exports` block:

```javascript
module.exports = {
  // Campaigns
  listCampaigns,
  getCampaign,
  getCampaignStats,
  getCampaignLeadStats,
  getCampaignEmailAccounts,
  // Leads
  uploadLeads,
  addLeadsToCampaign,
  chunkArray,
  // Email verification
  verifyEmails,
  getVerificationStatus,
  // Email accounts
  listEmailAccounts,
  getEmailAccount,
  updateEmailAccount,
  getWarmupStats,
  setWarmup,
  // Prospect (CLI)
  prospectSearch,
  prospectFindEmails,
  // Data export (CLI)
  exportCampaignCsv,
  exportAllLeadsCsv,
  getLeadCategories,
};
```

- [ ] **Step 3: Verify export count**

Run: `node -e "const sl = require('./shared/smartlead'); const keys = Object.keys(sl); console.log(keys.length + ' exports:', keys.join(', '))"`

Expected: `20 exports: listCampaigns, getCampaign, getCampaignStats, getCampaignLeadStats, getCampaignAnalytics, getCampaignEmailAccounts, uploadLeads, addLeadsToCampaign, chunkArray, verifyEmails, getVerificationStatus, listEmailAccounts, getEmailAccount, updateEmailAccount, getWarmupStats, setWarmup, prospectSearch, prospectFindEmails, exportCampaignCsv, exportAllLeadsCsv, getLeadCategories`

Verify no internal symbols leaked:
Run: `node -e "const sl = require('./shared/smartlead'); console.log('apiRequest:', typeof sl.apiRequest, '| BASE_URL:', typeof sl.BASE_URL)"`
Expected: `apiRequest: undefined | BASE_URL: undefined`

- [ ] **Step 4: Commit**

```bash
git add shared/smartlead.js
git commit -m "feat(smartlead): update exports, add JSDoc, remove internal symbols from public API"
```

---

### Task 5: Refactor mailbox_audit.js

**Files:**
- Modify: `4-analytics/mailbox_audit.js:13` (import line)
- Modify: `4-analytics/mailbox_audit.js:17-39` (delete local functions)

- [ ] **Step 1: Replace import and delete local wrappers**

Replace line 13:
```javascript
// OLD
const { apiRequest, listCampaigns } = require("../shared/smartlead");
```
With:
```javascript
// NEW
const {
  listCampaigns,
  getCampaignStats,
  listEmailAccounts,
  getEmailAccount,
  getWarmupStats,
  getCampaignEmailAccounts,
} = require("../shared/smartlead");
```

Delete lines 17-39 (the `// API helpers` section with all 5 local function definitions). Replace any call to the local `getCampaignAnalytics(cid)` with `getCampaignStats(cid)` (same endpoint).

- [ ] **Step 2: Verify the script loads**

Run: `node -e "require('./4-analytics/mailbox_audit'); console.log('loaded')" 2>&1 | head -1`

This will actually run the script (it calls `main()` at module level). Instead verify syntax:
Run: `node -c 4-analytics/mailbox_audit.js`
Expected: No output (success)

- [ ] **Step 3: Commit**

```bash
git add 4-analytics/mailbox_audit.js
git commit -m "refactor(mailbox_audit): use shared smartlead module instead of direct apiRequest"
```

---

### Task 6: Refactor configure_new_mailboxes.js

**Files:**
- Modify: `4-analytics/configure_new_mailboxes.js:14` (import line)
- Modify: `4-analytics/configure_new_mailboxes.js:155,221,240,250` (4 apiRequest call sites)

- [ ] **Step 1: Replace import**

Replace line 14:
```javascript
// OLD
const { apiRequest, listCampaigns } = require("../shared/smartlead");
```
With:
```javascript
// NEW
const {
  listCampaigns,
  listEmailAccounts,
  getEmailAccount,
  updateEmailAccount,
  setWarmup,
} = require("../shared/smartlead");
```

- [ ] **Step 2: Replace 4 inline apiRequest calls**

Line 155 — replace:
```javascript
const allAccounts = await apiRequest("GET", "/email-accounts");
```
With:
```javascript
const allAccounts = await listEmailAccounts();
```

Lines 221-224 — replace:
```javascript
await apiRequest("POST", `/email-accounts/${account.id}`, {
  max_email_per_day: 5,
  signature: signatureHtml,
});
```
With:
```javascript
await updateEmailAccount(account.id, {
  max_email_per_day: 5,
  signature: signatureHtml,
});
```

Line 240 — replace:
```javascript
await apiRequest("POST", `/email-accounts/${account.id}/warmup`, {
  warmup_enabled: true,
});
```
With:
```javascript
await setWarmup(account.id, true);
```

Lines 250-253 — replace:
```javascript
const verified = await apiRequest(
  "GET",
  `/email-accounts/${account.id}`
);
```
With:
```javascript
const verified = await getEmailAccount(account.id);
```

- [ ] **Step 3: Verify syntax**

Run: `node -c 4-analytics/configure_new_mailboxes.js`
Expected: No output (success)

- [ ] **Step 4: Commit**

```bash
git add 4-analytics/configure_new_mailboxes.js
git commit -m "refactor(configure_mailboxes): use shared smartlead module instead of direct apiRequest"
```

---

### Task 7: Refactor pull_leads.js

**Files:**
- Modify: `1-prospecting/pull_leads.js` (replace CLI helper with shared imports)

- [ ] **Step 1: Replace imports and delete local helpers**

Replace lines 9-26:
```javascript
// OLD
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { requireEnv } = require("../shared/env");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");

const DATA_RAW = projectPath("data", "raw");
ensureDir(DATA_RAW);

const apiKey = requireEnv("SMARTLEAD_API_KEY");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function smartlead(args) {
  return run(`smartlead --api-key "${apiKey}" ${args}`);
}
```
With:
```javascript
// NEW
const fs = require("fs");
const path = require("path");
const { projectPath, ensureDir, timestamp } = require("../shared/utils");
const {
  getLeadCategories,
  exportCampaignCsv,
  exportAllLeadsCsv,
} = require("../shared/smartlead");

const DATA_RAW = projectPath("data", "raw");
ensureDir(DATA_RAW);
```

- [ ] **Step 2: Replace CLI calls in main()**

Replace the categories call (lines 34-40):
```javascript
// OLD
const categories = smartlead("leads categories --format json");
console.log("Available categories:", categories.trim());
```
With:
```javascript
// NEW
const categories = getLeadCategories();
console.log("Available categories:", JSON.stringify(categories));
```

Replace campaign export (lines 46-48):
```javascript
// OLD
smartlead(`campaigns export --id ${campaignId} --out "${outFile}"`);
console.log(`Saved to ${outFile}`);
```
With:
```javascript
// NEW
const success = exportCampaignCsv(campaignId, outFile);
console.log(success ? `Saved to ${outFile}` : `Export failed for campaign ${campaignId}`);
```

Replace all-leads export (lines 51-54):
```javascript
// OLD
const csv = smartlead("leads list-all --all --format csv");
fs.writeFileSync(outFile, csv);
console.log(`Saved ${csv.split("\n").length - 1} leads to ${outFile}`);
```
With:
```javascript
// NEW
const csv = exportAllLeadsCsv();
if (csv) {
  fs.writeFileSync(outFile, csv);
  console.log(`Saved ${csv.split("\n").length - 1} leads to ${outFile}`);
} else {
  console.error("Failed to export leads.");
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -c 1-prospecting/pull_leads.js`
Expected: No output (success)

- [ ] **Step 4: Commit**

```bash
git add 1-prospecting/pull_leads.js
git commit -m "refactor(pull_leads): use shared smartlead CLI wrappers"
```

---

### Task 8: Refactor prospect_emails.js

**Files:**
- Modify: `3-outreach/prospect_emails.js` (replace `execSync` find-emails CLI call with shared wrapper)

- [ ] **Step 1: Add shared import, remove execSync**

Replace line 15:
```javascript
// OLD
const { execSync } = require("child_process");
```
With:
```javascript
// NEW
const { prospectFindEmails } = require("../shared/smartlead");
```

- [ ] **Step 2: Replace `findEmailsForDomain` function**

Replace the entire `findEmailsForDomain` function (lines 49-84) with:

```javascript
function findEmailsForDomain(domain, companyName) {
  return prospectFindEmails(domain, { firstName: "", lastName: "" });
}
```

The return shape `{emails, raw, error}` matches what the caller at line 137 expects.

- [ ] **Step 3: Verify syntax**

Run: `node -c 3-outreach/prospect_emails.js`
Expected: No output (success)

- [ ] **Step 4: Commit**

```bash
git add 3-outreach/prospect_emails.js
git commit -m "refactor(prospect_emails): use shared smartlead prospectFindEmails wrapper"
```

---

### Task 9: Refactor daily-prospect.js

**Files:**
- Modify: `scripts/daily-prospect.js` (replace 3 CLI calls, rename local function)

- [ ] **Step 1: Add shared imports**

Replace the smartlead import line (line 29):
```javascript
// OLD
const { uploadLeads, chunkArray } = require("../shared/smartlead");
```
With:
```javascript
// NEW
const {
  uploadLeads,
  chunkArray,
  prospectSearch: slProspectSearch,
  prospectFindEmails,
  exportCampaignCsv,
} = require("../shared/smartlead");
```

Remove `const { execSync } = require("child_process");` from line 21 (no longer needed). Keep `const os = require("os");` — it's still used by `dedupAgainstExisting` for `os.tmpdir()` when constructing the temp file path for `exportCampaignCsv`.

- [ ] **Step 2: Rename local `prospectSearch` to `runProspectSearches`**

Find the function definition (around line 186):
```javascript
function prospectSearch(rotation, limit, opts) {
```
Rename to:
```javascript
function runProspectSearches(rotation, limit, opts) {
```

Update the call site in `main()` (around line 690):
```javascript
// OLD
const rawLeads = prospectSearch(rotation, limit, opts);
// NEW
const rawLeads = runProspectSearches(rotation, limit, opts);
```

- [ ] **Step 3: Replace CLI call in `runProspectSearches`**

Replace lines 206-209:
```javascript
// OLD
const output = execSync(
  `smartlead prospect search --query "${query}"`,
  { encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
);
```
With:
```javascript
// NEW
const results = slProspectSearch(query);
```

Then simplify the result parsing block (lines 211-231). The old code parsed JSON manually from the raw CLI output. Now `slProspectSearch` returns a parsed array directly. Replace the entire block from `let results = [];` through the catch block with:

```javascript
if (results.length === 0) {
  log("SEARCH", `  0 results`);
  continue;
}
```

The domain-dedup loop below (lines 233-249) stays the same but already references `results`, so it works.

- [ ] **Step 4: Replace CLI call in `discoverEmails`**

Replace lines 289-317 (the tmpFile + execSync + JSON parsing block) with:

```javascript
    const result = prospectFindEmails(domain, {
      firstName: lead.first_name || "",
      lastName: lead.last_name || "",
    });
    if (result.emails.length > 0) {
      lead.email = result.emails[0];
      discovered++;
    }
```

Remove the `const tmpFile`, `fs.writeFileSync`, `fs.unlinkSync`, and the manual JSON parsing — all of that is now handled inside `prospectFindEmails`.

**Important:** Keep the existing `await sleep(200)` between iterations (lines 319-321) for rate limiting. The shared `prospectFindEmails` is synchronous and does not include any rate limiting. The loop structure with the sleep must be preserved.

- [ ] **Step 5: Replace CLI call in `dedupAgainstExisting`**

Replace lines 354-357:
```javascript
// OLD
execSync(
  `smartlead campaigns export --id ${campaignId} --out "${tmpFile}"`,
  { encoding: "utf-8", timeout: 120000, maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
);
```
With:
```javascript
// NEW
const success = exportCampaignCsv(campaignId, tmpFile);
if (!success) {
  log("DEDUP", `  Export failed for campaign ${campaignId}, skipping`);
  continue;
}
```

- [ ] **Step 6: Verify dry-run still works**

Run: `node scripts/daily-prospect.js --dry-run 2>&1 | head -5`
Expected:
```
[INIT] Daily Prospect — 2026-03-24 [DRY RUN]
[INIT] Rotation index: ...
[SEARCH] Rotation: ...
```

- [ ] **Step 7: Commit**

```bash
git add scripts/daily-prospect.js
git commit -m "refactor(daily-prospect): use shared smartlead CLI wrappers"
```

---

### Task 10: Final verification

**Files:** None modified — verification only.

- [ ] **Step 1: Verify export count**

Run: `node -e "const sl = require('./shared/smartlead'); const keys = Object.keys(sl); console.log(keys.length + ' exports'); console.log('apiRequest:', typeof sl.apiRequest);"`
Expected: `20 exports` and `apiRequest: undefined`

- [ ] **Step 2: Verify debug logging**

Run: `SMARTLEAD_DEBUG=1 node 4-analytics/campaign_stats.js 2>&1 | grep SmartLead | head -3`
Expected: Lines like `[SmartLead] GET /campaigns → 200 (234ms)`

- [ ] **Step 3: Verify no direct API calls remaining**

Run: `grep -rn "apiRequest" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules | grep -v docs/`
Expected: No output (0 results)

- [ ] **Step 4: Verify no inline CLI calls remaining**

Run: `grep -rn "execSync.*smartlead" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules | grep -v docs/`
Expected: No output (0 results)

- [ ] **Step 5: Run daily-prospect dry-run**

Run: `node scripts/daily-prospect.js --dry-run 2>&1 | tail -5`
Expected: Clean output showing rotation info, no errors.

- [ ] **Step 6: Run funnel tracker (regression test)**

Run: `node 5-lifecycle/funnel_tracker.js --campaign-id 2434779 2>&1 | head -10`
Expected: Campaign stats output matching previous run.

- [ ] **Step 7: Final commit and push**

```bash
git add -A
git status  # verify only expected files
git commit -m "chore: SmartLead API consolidation complete — all interactions via shared module"
git push
```
