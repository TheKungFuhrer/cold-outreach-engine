/**
 * Domain normalization and deduplication utilities.
 */

/**
 * Normalize a domain/URL to a clean domain string for dedup.
 * Strips protocol, www., trailing paths, query strings. Lowercases.
 * @param {string} raw - URL, domain, or empty string
 * @returns {string} normalized domain or empty string
 */
function normalizeDomain(raw) {
  if (!raw) return "";
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0]; // strip path
  d = d.split("?")[0]; // strip query
  d = d.split("#")[0]; // strip hash
  d = d.replace(/\.$/, ""); // strip trailing dot
  return d;
}

/**
 * Extract domain from an email address.
 * @param {string} email
 * @returns {string}
 */
function extractDomainFromEmail(email) {
  if (!email || !email.includes("@")) return "";
  return email.split("@")[1].trim().toLowerCase();
}

/**
 * Build a Set of normalized domains from an array of records.
 * Tries multiple field names to find the domain.
 * @param {object[]} records
 * @param {string[]} domainFields - candidate field names for domain/website
 * @param {string[]} [emailFields] - candidate field names for email (fallback)
 * @returns {Set<string>}
 */
function buildDomainSet(records, domainFields, emailFields) {
  const domains = new Set();
  for (const row of records) {
    let domain = "";
    for (const f of domainFields) {
      if (row[f]) {
        domain = normalizeDomain(row[f]);
        break;
      }
    }
    if (!domain && emailFields) {
      for (const f of emailFields) {
        if (row[f]) {
          domain = extractDomainFromEmail(row[f]);
          break;
        }
      }
    }
    if (domain) domains.add(domain);
  }
  return domains;
}

module.exports = { normalizeDomain, extractDomainFromEmail, buildDomainSet };
