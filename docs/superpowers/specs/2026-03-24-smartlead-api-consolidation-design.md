# SmartLead API Consolidation — Design Spec

## Problem

SmartLead API logic is scattered across 10 scripts. `shared/smartlead.js` exists but only covers 8 of ~21 needed functions. Two analytics scripts bypass it entirely with direct `apiRequest()` calls. Two prospecting scripts shell out to the SmartLead CLI without any shared wrapper. This makes the API surface hard to maintain, debug, and extend.

## Decision

Extend `shared/smartlead.js` as a flat module (no class refactor). Add ~13 new functions covering every SmartLead interaction in the codebase. Wrap CLI commands too. Add opt-in debug logging. Refactor 4 files that currently bypass the module.

## Architecture

### Module Structure

`shared/smartlead.js` remains a flat file of exported async functions. Functions are organized by JSDoc comment groups:

```
// --- Core (existing) ---
apiRequest(method, path, body, retries)   // internal, not exported
RateLimiter                                // internal class

// --- Campaigns ---
listCampaigns()
getCampaign(campaignId)
getCampaignStats(campaignId)
getCampaignAnalytics(campaignId)           // NEW
getCampaignEmailAccounts(campaignId)       // NEW

// --- Leads ---
uploadLeads(campaignId, leads, settings)
addLeadsToCampaign(campaignId, emailList)
chunkArray(arr, size)

// --- Email Verification ---
verifyEmails(campaignId)
getVerificationStatus(campaignId)

// --- Email Accounts ---                   // NEW group
listEmailAccounts()
getEmailAccount(accountId)
updateEmailAccount(accountId, config)
getWarmupStats(accountId)
setWarmup(accountId, enabled)

// --- Prospect (CLI wrappers) ---          // NEW group
prospectSearch(query)
prospectFindEmails(domain)

// --- Data Export (CLI wrappers) ---        // NEW group
exportCampaignCsv(campaignId, outPath)
exportAllLeadsCsv()
getLeadCategories()
```

Total: ~22 exported functions + RateLimiter + internal helpers.

### Debug Logging

Controlled by `SMARTLEAD_DEBUG=1` environment variable. When enabled, logs to stderr:

```
[SmartLead] GET /campaigns → 200 (234ms)
[SmartLead] POST /campaigns/3071191/leads (400 leads) → 200 (1.8s)
[SmartLead] CLI: smartlead prospect search --query "wedding venue TX" → OK (1.2s)
```

Implementation: a `debugLog(msg)` helper that checks `process.env.SMARTLEAD_DEBUG` once at module load. REST calls log method, path, status, and duration. CLI calls log the command and duration. Response bodies are NOT logged by default (too large for batch uploads). Full response logging available via `SMARTLEAD_DEBUG=verbose`.

### CLI Wrapper Pattern

CLI wrappers follow a consistent pattern:

```javascript
/**
 * Search for prospects matching a query.
 * @param {string} query - Search query (e.g. "wedding venue TX")
 * @returns {Array<Object>} Array of prospect results
 */
async function prospectSearch(query) {
  const apiKey = getApiKey();
  const start = Date.now();
  try {
    const output = execSync(
      `smartlead --api-key ${apiKey} prospect search --query "${query}"`,
      { encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
    );
    debugLog(`CLI: prospect search --query "${query}" → OK (${Date.now() - start}ms)`);
    return parseCLIOutput(output);
  } catch (err) {
    debugLog(`CLI: prospect search --query "${query}" → ERROR (${Date.now() - start}ms)`);
    return [];
  }
}
```

Key aspects:
- API key passed explicitly via `--api-key` flag (not relying on global CLI config)
- Timeout enforcement (60s for searches, 120s for exports)
- Graceful error handling — returns empty array/null on failure, never throws
- JSON output parsing with fallback for non-JSON CLI output

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

## Files Modified

### `shared/smartlead.js` — Extended

Add 13 new functions (listed above). Add debug logging infrastructure. Add JSDoc to all existing functions. No changes to existing function signatures or behavior.

### `4-analytics/mailbox_audit.js` — Refactored

**Before:** Defines 5 local functions calling `apiRequest()` directly (lines 22-38).
**After:** Imports `listEmailAccounts`, `getEmailAccount`, `getWarmupStats`, `getCampaignEmailAccounts`, `getCampaignAnalytics` from shared module. Deletes local function definitions.

### `4-analytics/configure_new_mailboxes.js` — Refactored

**Before:** Calls `apiRequest()` directly for account configuration (line 221) and warmup (line 240).
**After:** Imports `listEmailAccounts`, `updateEmailAccount`, `setWarmup` from shared module. Deletes direct API calls.

### `1-prospecting/pull_leads.js` — Refactored

**Before:** Three `execSync` calls to SmartLead CLI (lines 39, 45, 47).
**After:** Imports `getLeadCategories`, `exportCampaignCsv`, `exportAllLeadsCsv` from shared module.

### `scripts/daily-prospect.js` — Refactored

**Before:** Three `execSync` calls to SmartLead CLI for prospect search (line 156), find-emails (line 175), and campaign export (line 194).
**After:** Imports `prospectSearch`, `prospectFindEmails`, `exportCampaignCsv` from shared module.

## Files NOT Modified

- `3-outreach/upload_leads.js` — already uses shared module correctly
- `3-outreach/assign_campaigns.js` — already uses shared module correctly
- `3-outreach/verify_emails.js` — already uses shared module correctly
- `4-analytics/campaign_stats.js` — already uses shared module correctly
- `5-lifecycle/funnel_tracker.js` — already uses shared module correctly
- `scripts/update-dashboards.js` — already uses shared module correctly

## Verification

1. **Module exports check:** `node -e "const sl = require('./shared/smartlead'); console.log(Object.keys(sl).length, 'exports:', Object.keys(sl).join(', '))"`
2. **Debug logging:** `SMARTLEAD_DEBUG=1 node 4-analytics/campaign_stats.js` — verify log lines appear
3. **Mailbox audit:** `node 4-analytics/mailbox_audit.js` — verify it works with shared imports
4. **Daily prospect dry-run:** `node scripts/daily-prospect.js --dry-run` — verify CLI wrappers work
5. **Funnel tracker:** `node 5-lifecycle/funnel_tracker.js --campaign-id 2434779` — verify existing functions unchanged
6. **No direct API calls remaining:** `grep -r "apiRequest" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules` — should return 0 results
7. **No inline CLI calls remaining:** `grep -rn "execSync.*smartlead" --include="*.js" | grep -v shared/smartlead.js | grep -v node_modules` — should return 0 results
