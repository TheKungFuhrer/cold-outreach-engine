/**
 * Cold-outreach identity adapter.
 *
 * Provides functions for loading cold leads into the shared identity DB,
 * checking for Skool member overlaps, and marking suppressed emails.
 */

const { openDb, getDb, closeDb, normalizeEmail } = require("./identity-db");
const { extractDomainFromEmail, normalizeDomain } = require("./dedup");

/**
 * Bulk-upsert cold leads into the identity DB.
 * Sets cold_outreach_lead=1, preserves existing skool data.
 * @param {object[]} records - Array of lead objects (must have email field)
 * @returns {{ upserted: number, skipped: number }}
 */
function loadColdLeads(records) {
  const db = getDb();
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO contacts (email, domain, first_name, last_name, company_name, phone, website, source, cold_outreach_lead, first_seen_cold, last_synced)
    VALUES (@email, @domain, @first_name, @last_name, @company_name, @phone, @website, @source, 1, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      cold_outreach_lead = 1,
      domain = COALESCE(contacts.domain, excluded.domain),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      company_name = COALESCE(NULLIF(contacts.company_name, ''), excluded.company_name),
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      website = COALESCE(NULLIF(contacts.website, ''), excluded.website),
      first_seen_cold = COALESCE(contacts.first_seen_cold, excluded.first_seen_cold),
      last_synced = @now
  `);

  let upserted = 0;
  let skipped = 0;

  const runBatch = db.transaction((batch) => {
    for (const row of batch) {
      const email = normalizeEmail(row.email || row.Email || row.email_address || "");
      if (!email || !email.includes("@")) { skipped++; continue; }

      const domain = normalizeDomain(row.website || row.company_domain || "") || extractDomainFromEmail(email);

      upsert.run({
        email,
        domain,
        first_name: (row.first_name || row["First Name"] || "").trim(),
        last_name: (row.last_name || row["Last Name"] || "").trim(),
        company_name: (row.company_name || row.company || "").trim(),
        phone: (row.phone_number || row.phone || "").trim(),
        website: (row.website || row.company_domain || "").trim(),
        source: "cold_outreach",
        now,
      });
      upserted++;
    }
  });

  for (let i = 0; i < records.length; i += 5000) {
    runBatch(records.slice(i, i + 5000));
  }

  return { upserted, skipped };
}

function checkOverlaps(emails) {
  const db = getDb();
  const stmt = db.prepare("SELECT email FROM contacts WHERE email = ? AND skool_member = 1");

  const overlaps = [];
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    const row = stmt.get(email);
    if (row) overlaps.push(row.email);
  }
  return overlaps;
}

function markSuppressed(emails) {
  const db = getDb();
  const stmt = db.prepare("UPDATE contacts SET smartlead_suppressed = 1 WHERE email = ?");
  const run = db.transaction((batch) => {
    for (const raw of batch) {
      stmt.run(normalizeEmail(raw));
    }
  });
  run(emails);
}

function getStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM contacts").get().c;
  const cold = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1").get().c;
  const skool = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE skool_member = 1").get().c;
  const overlaps = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE cold_outreach_lead = 1 AND skool_member = 1").get().c;
  const suppressed = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE smartlead_suppressed = 1").get().c;

  const sourceRows = db.prepare("SELECT source, COUNT(*) as c FROM contacts GROUP BY source").all();
  const by_source = {};
  for (const row of sourceRows) {
    by_source[row.source || "unknown"] = row.c;
  }

  return { total, cold_outreach: cold, skool, overlaps, suppressed, by_source };
}

module.exports = { openDb, closeDb, loadColdLeads, checkOverlaps, markSuppressed, getStats };
