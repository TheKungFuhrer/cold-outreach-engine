/**
 * SmartLead REST API client.
 *
 * Base URL: https://server.smartlead.ai/api/v1/
 * Auth: ?api_key= query parameter
 * Rate limit: 10 requests per 2 seconds
 * Max 400 leads per upload request
 */

const { requireEnv } = require("./env");
const { execSync } = require("child_process");

const DEBUG = process.env.SMARTLEAD_DEBUG || "";
function debugLog(msg) {
  if (DEBUG) process.stderr.write(`[SmartLead] ${msg}\n`);
}
function debugVerbose(msg) {
  if (DEBUG === "verbose") process.stderr.write(`[SmartLead] ${msg}\n`);
}

const BASE_URL = "https://server.smartlead.ai/api/v1";

/**
 * Return the SmartLead API key from environment.
 * @returns {string} API key
 * @throws {Error} If SMARTLEAD_API_KEY is not set
 */
function getApiKey() {
  return requireEnv("SMARTLEAD_API_KEY");
}

// ---------------------------------------------------------------------------
// Rate limiter — token bucket, 10 requests per 2-second window
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor(maxRequests = 10, windowMs = 2000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async acquire() {
    while (true) {
      const now = Date.now();
      // Remove timestamps outside the window
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      // Wait until the oldest timestamp exits the window
      const waitMs = this.timestamps[0] + this.windowMs - now + 10;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const rateLimiter = new RateLimiter();

// ---------------------------------------------------------------------------
// Core HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the SmartLead REST API.
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - API path (e.g. "/campaigns")
 * @param {Object|null} body - JSON request body, or null for GET
 * @param {number} retries - Number of retry attempts for 429/5xx errors
 * @returns {Promise<Object|string>} Parsed JSON response, or raw text if not JSON
 * @throws {Error} On non-retryable HTTP errors
 */
async function apiRequest(method, path, body = null, retries = 3) {
  const url = `${BASE_URL}${path}?api_key=${getApiKey()}`;
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  await rateLimiter.acquire();

  const start = Date.now();
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        console.warn(
          `  SmartLead API ${res.status} — retry ${attempt}/${retries} in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        await rateLimiter.acquire();
        continue;
      }
    }

    const text = await res.text();
    debugLog(`${method} ${path} → ${res.status} (${Date.now() - start}ms)`);
    debugVerbose(`Response: ${text.slice(0, 500)}`);
    if (!res.ok) {
      throw new Error(
        `SmartLead API ${method} ${path} → ${res.status}: ${text}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Run a SmartLead CLI command synchronously.
 * @param {string} args - CLI arguments (e.g. "campaigns list --format json")
 * @param {Object} [options]
 * @param {number} [options.timeout=60000] - Command timeout in ms
 * @param {number} [options.maxBuffer=52428800] - Max stdout buffer (50 MB)
 * @returns {string|null} CLI stdout, or null on error
 * @note Never throws — returns null on CLI failure
 */
function runCLI(args, { timeout = 60000, maxBuffer = 50 * 1024 * 1024 } = {}) {
  const apiKey = getApiKey();
  const cmd = `smartlead --api-key "${apiKey}" ${args}`;
  const start = Date.now();
  try {
    const output = execSync(cmd, {
      encoding: "utf-8", timeout, maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
    });
    debugLog(`CLI: ${args} → OK (${Date.now() - start}ms)`);
    return output;
  } catch (err) {
    debugLog(`CLI: ${args} → ERROR (${Date.now() - start}ms): ${err.message.split("\n")[0]}`);
    return null;
  }
}

/**
 * Parse CLI output into a structured array or object.
 * @param {string|null} output - Raw CLI stdout
 * @returns {Array|Object|null} Parsed data, empty array for empty output, null on parse failure
 */
function parseCLIOutput(output) {
  if (!output) return [];
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const jsonStart = trimmed.indexOf("[") !== -1 ? trimmed.indexOf("[") : trimmed.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(trimmed.slice(jsonStart));
    if (Array.isArray(parsed)) return parsed;
    return parsed.data || parsed.results || [parsed];
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Campaign operations
// ---------------------------------------------------------------------------

/**
 * List all campaigns.
 * @returns {Promise<Array<Object>>} Array of campaign objects
 * @throws {Error} On API error
 */
async function listCampaigns() {
  return apiRequest("GET", "/campaigns");
}

/**
 * Get a single campaign by ID.
 * @param {number} campaignId - Campaign ID
 * @returns {Promise<Object>} Campaign details
 * @throws {Error} On API error
 */
async function getCampaign(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}`);
}

// ---------------------------------------------------------------------------
// Lead operations
// ---------------------------------------------------------------------------

/**
 * Upload leads to a campaign. Max 400 per request (enforced here).
 * @param {number} campaignId
 * @param {Array<Object>} leads - array of lead objects with email, first_name, etc.
 * @param {Object} settings - optional upload settings
 * @returns {Promise<Object>} API response
 * @throws {Error} If more than 400 leads or on API error
 */
async function uploadLeads(campaignId, leads, settings = {}) {
  if (leads.length > 400) {
    throw new Error(
      `uploadLeads: max 400 leads per request, got ${leads.length}. Chunk before calling.`
    );
  }
  return apiRequest("POST", `/campaigns/${campaignId}/leads`, {
    lead_list: leads,
    settings,
  });
}

/**
 * Add existing leads to a campaign by email.
 * @param {number} campaignId
 * @param {Array<string>} emailList - Array of email addresses
 * @returns {Promise<Object>} API response
 * @throws {Error} On API error
 */
async function addLeadsToCampaign(campaignId, emailList) {
  return apiRequest("POST", `/campaigns/${campaignId}/leads/add`, {
    lead_list: emailList,
  });
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Trigger email verification for a campaign.
 * @param {number} campaignId
 * @returns {Promise<Object>} API response
 * @throws {Error} On API error
 */
async function verifyEmails(campaignId) {
  return apiRequest("POST", `/campaigns/${campaignId}/verify-emails`);
}

/**
 * Get email verification status for a campaign.
 * @param {number} campaignId
 * @returns {Promise<Object>} Verification status
 * @throws {Error} On API error
 */
async function getVerificationStatus(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/verify-emails/status`);
}

// ---------------------------------------------------------------------------
// Email account operations
// ---------------------------------------------------------------------------

/**
 * List all email accounts.
 * @returns {Promise<Array<Object>>} Array of email account objects
 * @throws {Error} On API error
 */
async function listEmailAccounts() {
  return apiRequest("GET", "/email-accounts");
}

/**
 * Get a single email account by ID.
 * @param {number} accountId - Email account ID
 * @returns {Promise<Object>} Email account details
 * @throws {Error} On API error
 */
async function getEmailAccount(accountId) {
  return apiRequest("GET", `/email-accounts/${accountId}`);
}

/**
 * Update an email account's configuration.
 * @param {number} accountId - Email account ID
 * @param {Object} config - Configuration fields to update
 * @returns {Promise<Object>} API response
 * @throws {Error} On API error
 */
async function updateEmailAccount(accountId, config) {
  return apiRequest("POST", `/email-accounts/${accountId}`, config);
}

/**
 * Get warmup statistics for an email account.
 * @param {number} accountId - Email account ID
 * @returns {Promise<Object>} Warmup stats
 * @throws {Error} On API error
 */
async function getWarmupStats(accountId) {
  return apiRequest("GET", `/email-accounts/${accountId}/warmup-stats`);
}

/**
 * Enable or disable warmup for an email account.
 * @param {number} accountId - Email account ID
 * @param {boolean} enabled - Whether to enable warmup
 * @returns {Promise<Object>} API response
 * @throws {Error} On API error
 */
async function setWarmup(accountId, enabled) {
  return apiRequest("POST", `/email-accounts/${accountId}/warmup`, { enabled });
}

// ---------------------------------------------------------------------------
// Lead status / stats
// ---------------------------------------------------------------------------

/**
 * Get lead-level stats for a campaign (counts by status).
 * @param {number} campaignId
 * @returns {Promise<Object>} Lead stats breakdown
 * @throws {Error} On API error
 */
async function getCampaignLeadStats(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/leads/stats`);
}

/**
 * Get campaign analytics (opens, replies, bounces, etc.).
 * @param {number} campaignId
 * @returns {Promise<Object>} Campaign analytics data
 * @throws {Error} On API error
 */
async function getCampaignStats(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/analytics`);
}

/**
 * Get email accounts linked to a campaign.
 * @param {number} campaignId
 * @returns {Promise<Array<Object>>} Array of email account objects
 * @throws {Error} On API error
 */
async function getCampaignEmailAccounts(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/email-accounts`);
}

// ---------------------------------------------------------------------------
// Utility: chunk array for batch uploads
// ---------------------------------------------------------------------------

/**
 * Split an array into chunks of the given size.
 * @param {Array} arr - Array to chunk
 * @param {number} [size=400] - Chunk size
 * @returns {Array<Array>} Array of chunks
 */
function chunkArray(arr, size = 400) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// CLI wrapper functions
// ---------------------------------------------------------------------------

/**
 * Search for prospects using SmartLead CLI.
 * @param {string} query - Search query string
 * @returns {Array<Object>} Array of prospect results, or empty array on failure
 * @note Never throws — returns empty array on CLI failure
 */
function prospectSearch(query) {
  const output = runCLI(`prospect search --query "${query}" --format json`);
  return parseCLIOutput(output) || [];
}

/**
 * Find emails for a domain using SmartLead CLI prospect discovery.
 * @param {string} domain - Domain to search (e.g. "example.com")
 * @param {Object} [contact={}] - Optional contact hints (first_name, last_name, etc.)
 * @returns {{ emails: Array, raw: string|null, error: string|null }} Results object
 * @note Never throws — returns empty emails array on CLI failure
 */
function prospectFindEmails(domain, contact = {}) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const payload = { domain, ...contact };
  const tmpFile = path.join(os.tmpdir(), `smartlead-prospect-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    const output = runCLI(`prospect find-emails --from-json "${tmpFile}"`);
    const parsed = parseCLIOutput(output);
    return { emails: parsed || [], raw: output, error: null };
  } catch (err) {
    return { emails: [], raw: null, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Export a campaign's leads to a CSV file using SmartLead CLI.
 * @param {number} campaignId - Campaign ID to export
 * @param {string} outPath - Output file path for the CSV
 * @returns {boolean} True if export succeeded, false otherwise
 * @note Never throws — returns false on CLI failure
 */
function exportCampaignCsv(campaignId, outPath) {
  const output = runCLI(`campaigns export --id ${campaignId} --out "${outPath}"`);
  return output !== null;
}

/**
 * Export all leads across all campaigns as CSV using SmartLead CLI.
 * @returns {string|null} CSV string, or null on failure
 * @note Never throws — returns null on CLI failure
 */
function exportAllLeadsCsv() {
  return runCLI("leads list-all --all --format csv", { timeout: 120000 });
}

/**
 * Get lead category definitions from SmartLead CLI.
 * @returns {Array<Object>|null} Array of category objects, or null on failure
 * @note Never throws — returns null on CLI failure
 */
function getLeadCategories() {
  const output = runCLI("leads categories --format json");
  return parseCLIOutput(output);
}

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listCampaigns, getCampaign, getCampaignStats, getCampaignLeadStats, getCampaignEmailAccounts,
  getCampaignLeads, getLeadMessageHistory,
  uploadLeads, addLeadsToCampaign, chunkArray,
  verifyEmails, getVerificationStatus,
  listEmailAccounts, getEmailAccount, updateEmailAccount, getWarmupStats, setWarmup,
  prospectSearch, prospectFindEmails,
  exportCampaignCsv, exportAllLeadsCsv, getLeadCategories,
};
