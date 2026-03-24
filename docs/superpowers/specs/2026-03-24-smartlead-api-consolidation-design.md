# SmartLead API Consolidation — Design Spec

## Problem

SmartLead API logic is scattered across 10 scripts. `shared/smartlead.js` currently exports 13 symbols (including internal helpers like `apiRequest`, `getApiKey`, `RateLimiter`, `BASE_URL`). Two analytics scripts import `apiRequest` directly and bypass the named wrapper pattern. Two prospecting scripts shell out to the SmartLead CLI without any shared wrapper. This makes the API surface hard to maintain, debug, and extend.

## Decision

Extend `shared/smartlead.js` as a flat module (no class refactor). Add ~13 new named functions covering every SmartLead interaction in the codebase. Wrap CLI commands too. Add opt-in debug logging. Refactor 4 files that currently bypass the module. Remove `apiRequest` from exports — all callers use named functions only.

## Architecture

### Module Structure

`shared/smartlead.js` remains a flat file of exported async functions. Functions organized by JSDoc comment groups:

```
// --- Core (internal only, NOT exported after refactor) ---
apiRequest(method, path, body, retries)   // HTTP helper with rate limiting + retry
RateLimiter                                // token bucket rate limiter
getApiKey()                                // reads SMARTLEAD_API_KEY from env
BASE_URL                                   // https://server.smartlead.ai/api/v1
debugLog(msg)                              // NEW — logs to stderr when SMARTLEAD_DEBUG=1
parseCLIOutput(output)                     // NEW — parses CLI JSON/text output
runCLI(args, opts)                         // NEW — execSync wrapper with debug logging

// --- Campaigns (exported) ---
listCampaigns()
getCampaign(campaignId)
getCampaignStats(campaignId)               // GET /campaigns/{id}/stats (existing)
getCampaignLeadStats(campaignId)           // GET /campaigns/{id}/leads/stats (existing, kept)
getCampaignAnalytics(campaignId)           // NEW — GET /campaigns/{id}/analytics
getCampaignEmailAccounts(campaignId)       // NEW — GET /campaigns/{id}/email-accounts

// --- Leads (exported) ---
uploadLeads(campaignId, leads, settings)
addLeadsToCampaign(campaignId, emailList)
chunkArray(arr, size)

// --- Email Verification (exported) ---
verifyEmails(campaignId)
getVerificationStatus(campaignId)

// --- Email Accounts (NEW group, exported) ---
listEmailAccounts()
getEmailAccount(accountId)
updateEmailAccount(accountId, config)      // POST /email-accounts/{id} (SmartLead uses POST, not PATCH)
getWarmupStats(accountId)
setWarmup(accountId, enabled)

// --- Prospect (NEW CLI wrappers, exported) ---
prospectSearch(query)
prospectFindEmails(domain)

// --- Data Export (NEW CLI wrappers, exported) ---
exportCampaignCsv(campaignId, outPath)     // outPath required — caller decides where
exportAllLeadsCsv()                        // returns CSV string
getLeadCategories()                        // returns parsed JSON array
```

**Breaking change:** `apiRequest`, `getApiKey`, `RateLimiter`, and `BASE_URL` are removed from `module.exports`. All callers must use named wrapper functions. `mailbox_audit.js` and `configure_new_mailboxes.js` currently import `apiRequest` and will be refactored.

### Debug Logging

Controlled by `SMARTLEAD_DEBUG` environment variable, cached once at module load:

- **Off (default):** No logging. Normal runs stay clean.
- **`SMARTLEAD_DEBUG=1`:** One-line summaries to stderr:
  ```
  [SmartLead] GET /campaigns → 200 (234ms)
  [SmartLead] POST /campaigns/3071191/leads (400 leads) → 200 (1.8s)
  [SmartLead] CLI: prospect search --query "wedding venue TX" → OK (1.2s)
  ```
- **`SMARTLEAD_DEBUG=verbose`:** Summary lines + full response bodies (for debugging).

CLI stderr output is suppressed in non-debug mode (`stdio: ["pipe", "pipe", "pipe"]`). In verbose mode, CLI stderr is forwarded to the debug log.

### CLI Wrapper Pattern

All CLI wrappers use an internal `runCLI(args, opts)` helper:

```javascript
function runCLI(args, { timeout = 60000, maxBuffer = 50 * 1024 * 1024 } = {}) {
  const apiKey = getApiKey();
  const cmd = `smartlead --api-key ${apiKey} ${args}`;
  const start = Date.now();
  try {
    const output = execSync(cmd, {
      encoding: "utf-8", timeout, maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
    });
    debugLog(`CLI: ${args} → OK (${Date.now() - start}ms)`);
    return output;
  } catch (err) {
    debugLog(`CLI: ${args} → ERROR (${Date.now() - start}ms): ${err.message.split("\\n")[0]}`);
    return null;
  }
}
```

`parseCLIOutput(output)` handles the known SmartLead CLI output formats:
1. Pure JSON array → parse and return
2. JSON object with `.data` or `.results` field → unwrap and return the array
3. Non-JSON text → return null (caller handles gracefully)
4. Null input (from runCLI failure) → return empty array

CLI wrappers never throw. They return `[]` or `null` on failure.

```javascript
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
```

### `exportCampaignCsv` Signature

Takes an explicit `outPath` parameter. The caller decides the file location:

```javascript
/**
 * Export campaign leads to a CSV file via SmartLead CLI.
 * @param {string|number} campaignId - Campaign ID
 * @param {string} outPath - Absolute path for the output CSV
 * @returns {boolean} true if export succeeded, false on failure
 */
function exportCampaignCsv(campaignId, outPath) { ... }
```

Both call sites (`pull_leads.js` and `daily-prospect.js`) already construct their own output paths, so this signature matches existing usage.

### JSDoc Standard

Every exported function gets:

```javascript
/**
 * Brief one-line description.
 *
 * @param {string} campaignId - The SmartLead campaign ID
 * @param {Object[]} leads - Array of lead objects
 * @param {Object} [settings={}] - Optional upload settings
 * @returns {Promise<Object>} Upload result with success count and duplicate count
 * @throws {Error} If API returns non-retryable error (4xx except 429)
 */
```

CLI wrappers add `@note Never throws — returns empty array/null on CLI failure`.

## Files Modified

### `shared/smartlead.js` — Extended

- Add 13 new exported functions (listed above)
- Add internal helpers: `debugLog`, `runCLI`, `parseCLIOutput`
- Add JSDoc to all existing and new functions
- Remove `apiRequest`, `getApiKey`, `RateLimiter`, `BASE_URL` from `module.exports`
- No changes to existing function signatures or behavior

### `4-analytics/mailbox_audit.js` — Refactored

**Before:** Imports `apiRequest` (line 13). Defines 5 local wrapper functions calling it directly (lines 22-38): `listEmailAccounts`, `getEmailAccount`, `getWarmupStats`, `getCampaignEmailAccounts`, `getCampaignAnalytics`.

**After:** Imports named functions from shared module: `listEmailAccounts`, `getEmailAccount`, `getWarmupStats`, `getCampaignEmailAccounts`, `getCampaignAnalytics`. Deletes local function definitions and `apiRequest` import.

### `4-analytics/configure_new_mailboxes.js` — Refactored

**Before:** Imports `apiRequest` (line 14). Makes 4 direct API calls:
- Line 155: `apiRequest("GET", "/email-accounts")` — listing accounts
- Line 221: `apiRequest("POST", "/email-accounts/{id}", config)` — configuring account
- Line 240: `apiRequest("POST", "/email-accounts/{id}/warmup", ...)` — enabling warmup
- Line 250: `apiRequest("GET", "/email-accounts/{id}")` — verifying configuration

**After:** Imports `listEmailAccounts`, `getEmailAccount`, `updateEmailAccount`, `setWarmup` from shared module. Replaces all 4 `apiRequest` calls with named functions. Deletes `apiRequest` import.

### `1-prospecting/pull_leads.js` — Refactored

**Before:** Three `execSync` calls to SmartLead CLI (lines 36, 47, 52) using a local `smartlead()` helper.

**After:** Imports `getLeadCategories`, `exportCampaignCsv`, `exportAllLeadsCsv` from shared module. Deletes local `smartlead()` helper and `execSync` import.

### `scripts/daily-prospect.js` — Refactored

**Before:** Three inline `execSync` calls:
- Line 207: `smartlead prospect search --query` (inside local `prospectSearch` function)
- Line 297: `smartlead prospect find-emails --from-json` (inside `discoverEmails`)
- Line 355: `smartlead campaigns export --id` (inside `dedupAgainstExisting`)

**After:** Imports `prospectSearch` (renamed to `slProspectSearch` to avoid collision with local `runProspectSearches` function), `prospectFindEmails`, `exportCampaignCsv` from shared module. The local function at line 186 is renamed from `prospectSearch` to `runProspectSearches` and calls `slProspectSearch(query)` inside its loop. Deletes inline `execSync` calls.

## Files NOT Modified

- `3-outreach/upload_leads.js` — already uses shared module correctly
- `3-outreach/assign_campaigns.js` — already uses shared module correctly
- `3-outreach/verify_emails.js` — already uses shared module correctly
- `4-analytics/campaign_stats.js` — already uses shared module correctly
- `5-lifecycle/funnel_tracker.js` — already uses shared module correctly
- `scripts/update-dashboards.js` — already uses shared module correctly

## Verification

1. **Module exports check:** `node -e "const sl = require('./shared/smartlead'); console.log(Object.keys(sl).length, 'exports:', Object.keys(sl).join(', '))"` — should list ~22 named functions, no `apiRequest`
2. **Debug logging:** `SMARTLEAD_DEBUG=1 node 4-analytics/campaign_stats.js` — verify log lines on stderr
3. **Mailbox audit:** `node 4-analytics/mailbox_audit.js` — verify it works with shared imports
4. **Configure mailboxes:** `node -e "require('./4-analytics/configure_new_mailboxes')"` — verify it loads without error
5. **Pull leads:** `node 1-prospecting/pull_leads.js --help 2>&1 || true` — verify it loads without error
6. **Daily prospect dry-run:** `node scripts/daily-prospect.js --dry-run` — verify CLI wrappers work
7. **Funnel tracker:** `node 5-lifecycle/funnel_tracker.js --campaign-id 2434779` — verify existing functions unchanged
8. **No direct API calls remaining:** `grep -r "apiRequest" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules` — should return 0 results
9. **No inline CLI calls remaining:** `grep -rn "execSync.*smartlead" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules` — should return 0 results
