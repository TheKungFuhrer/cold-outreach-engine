/**
 * SmartLead REST API client (stub — full implementation next session).
 *
 * Base URL: https://server.smartlead.ai/api/v1/
 * Auth: ?api_key= query parameter
 * Rate limit: 10 requests per 2 seconds
 */

const { requireEnv } = require("./env");

const BASE_URL = "https://server.smartlead.ai/api/v1";

function getApiKey() {
  return requireEnv("SMARTLEAD_API_KEY");
}

// TODO: Implement in next session
// - listCampaigns()
// - createLeadList(name)
// - uploadLeads(listId, leads[]) — max 400 per request
// - addLeadsToCampaign(campaignId, leads[])
// - verifyEmails(emails[])
// - findEmails(domains[])

module.exports = { BASE_URL, getApiKey };
