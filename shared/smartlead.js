/**
 * SmartLead REST API client.
 *
 * Base URL: https://server.smartlead.ai/api/v1/
 * Auth: ?api_key= query parameter
 * Rate limit: 10 requests per 2 seconds
 * Max 400 leads per upload request
 */

const { requireEnv } = require("./env");

const BASE_URL = "https://server.smartlead.ai/api/v1";

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
// Campaign operations
// ---------------------------------------------------------------------------

async function listCampaigns() {
  return apiRequest("GET", "/campaigns");
}

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
 * @returns {Object} API response
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
 * @param {Array<string>} emailList
 */
async function addLeadsToCampaign(campaignId, emailList) {
  return apiRequest("POST", `/campaigns/${campaignId}/leads/add`, {
    lead_list: emailList,
  });
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

async function verifyEmails(campaignId) {
  return apiRequest("POST", `/campaigns/${campaignId}/verify-emails`);
}

async function getVerificationStatus(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/verify-emails/status`);
}

// ---------------------------------------------------------------------------
// Lead status / stats
// ---------------------------------------------------------------------------

async function getCampaignLeadStats(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/leads/stats`);
}

async function getCampaignStats(campaignId) {
  return apiRequest("GET", `/campaigns/${campaignId}/analytics`);
}

// ---------------------------------------------------------------------------
// Utility: chunk array for batch uploads
// ---------------------------------------------------------------------------

function chunkArray(arr, size = 400) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  BASE_URL,
  getApiKey,
  RateLimiter,
  apiRequest,
  listCampaigns,
  getCampaign,
  uploadLeads,
  addLeadsToCampaign,
  verifyEmails,
  getVerificationStatus,
  getCampaignLeadStats,
  getCampaignStats,
  chunkArray,
};
