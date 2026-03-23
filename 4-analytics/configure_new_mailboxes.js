/**
 * Configure New Mailboxes — Identify new SmartLead email accounts,
 * set warmup-appropriate settings, generate unique signatures, and apply.
 *
 * Targets: accounts on omgdirectory.com and joinomgvenuelist.com domains
 * that have no campaign assignments and no warmup history.
 *
 * Settings applied:
 *   - message_per_day: 5 (brand new accounts, slow ramp)
 *   - warmup enabled with conservative limits (min 1, max 5)
 *   - Unique signatures matching active account branding
 */

const { apiRequest, listCampaigns } = require("../shared/smartlead");
const { ensureDir, projectPath, timestamp } = require("../shared/utils");
const fs = require("fs");

// -------------------------------------------------------------------------
// New account domains to look for
// -------------------------------------------------------------------------
const NEW_DOMAINS = ["omgdirectory.com", "joinomgvenuelist.com"];

// -------------------------------------------------------------------------
// Signature templates — varied wording, same structure/branding as actives
// -------------------------------------------------------------------------

// Pool of closings, taglines, and CTAs to mix-and-match per account
const CLOSINGS = [
  "Best,",
  "Cheers,",
  "Warmly,",
  "Talk soon,",
  "All the best,",
  "Thanks,",
  "To your success,",
  "Regards,",
  "Looking forward,",
  "Here to help,",
  "Excited for you,",
  "Onward,",
  "With appreciation,",
  "Keep crushing it,",
  "Wishing you the best,",
];

const TAGLINES_DYLAN = [
  "Founder, OMG Rentals | Turning spaces into income",
  "Helping venue owners scale to $10k/month and beyond",
  "Founder, OMG Rentals | 6-figure venue systems",
  "Building hands-off income streams for venue owners",
  "OMG Rentals | Proven frameworks for venue profitability",
  "Founder, OMG Rentals | From empty space to booked venue",
  "Showing venue owners the path to consistent 5-figure months",
  "OMG Rentals | Revenue systems for event spaces",
  "Founder, OMG Rentals",
  "Helping property owners launch profitable event venues",
  "OMG Rentals | The $10k/month venue playbook",
  "Founder, OMG Rentals | Making venues work while you don't",
  "Venue growth strategist | OMG Rentals",
  "Teaching venue owners to build real, lasting income",
  "OMG Rentals | Passive venue income, proven process",
];

const TAGLINES_ISAAC = [
  "Helping venue owners hit $10k/month on autopilot",
  "Guiding property owners to 6-figure venue income",
  "Teaching venue income strategies that actually scale",
  "Helping homeowners build hands-off $10k/month venues",
  "Venue growth systems that work while you sleep",
  "Your guide to consistent venue profitability",
  "Making 6-figure venue income achievable for anyone",
  "Turning underused spaces into income-generating venues",
  "Venue income coach | OMG Rentals",
  "Helping venue owners create freedom through events",
  "Building the playbook for profitable event spaces",
  "Event venue revenue strategist",
  "Helping new venue owners avoid costly mistakes",
  "From side hustle to 6-figure venue — step by step",
  "OMG Rentals team | Venue owner success",
];

const TAGLINES_SHIELA = [
  "Supporting event space owners on the path to $10k/month",
  "Helping you maximize your venue's earning potential",
  "Resources and guidance for 6-figure venue growth",
  "Helping venue owners unlock consistent bookings",
  "Your partner in building a profitable venue business",
  "Event venue success strategist | OMG Rentals",
  "Helping venue owners create reliable monthly income",
  "Making venue profitability simple and repeatable",
  "OMG Rentals team | Venue growth support",
  "Guiding venue owners from launch to 6 figures",
  "Dedicated to helping venues thrive",
  "Helping venue owners turn passion into profit",
  "Supporting your journey to $10k/month venues",
  "Venue operations + growth | OMG Rentals",
  "Empowering venue owners with proven systems",
];

const CTAS = [
  "Join the 5-day $10k Venue Challenge: https://www.skool.com/omg-rentals/about",
  "Free community for venue owners: https://www.skool.com/omg-rentals/about",
  "Get free access: https://www.skool.com/omg-rentals/about",
  "Join our venue owner community: https://www.skool.com/omg-rentals/about",
  "See the challenge details: https://www.skool.com/omg-rentals/about",
  "Learn more about the $10k Challenge: https://www.skool.com/omg-rentals/about",
  "Free venue growth resources: https://www.skool.com/omg-rentals/about",
  "Join 500+ venue owners here: https://www.skool.com/omg-rentals/about",
  "Explore the free community: https://www.skool.com/omg-rentals/about",
  "Start the free 5-day challenge: https://www.skool.com/omg-rentals/about",
  "Access the venue playbook: https://www.skool.com/omg-rentals/about",
  "Join the venue owner network: https://www.skool.com/omg-rentals/about",
  "Your invite to the $10k Challenge: https://www.skool.com/omg-rentals/about",
  "Free resources + community: https://www.skool.com/omg-rentals/about",
  "Get the venue growth blueprint: https://www.skool.com/omg-rentals/about",
];

// Deterministic but varied selection based on account index
function pickFromPool(pool, index) {
  return pool[index % pool.length];
}

function getTaglinePool(name) {
  const lower = name.toLowerCase();
  if (lower.includes("dylan")) return TAGLINES_DYLAN;
  if (lower.includes("isaac")) return TAGLINES_ISAAC;
  if (lower.includes("shiela")) return TAGLINES_SHIELA;
  return TAGLINES_DYLAN; // default
}

function generateSignature(account, index) {
  const closing = pickFromPool(CLOSINGS, index);
  const taglinePool = getTaglinePool(account.from_name);
  const tagline = pickFromPool(taglinePool, index + 3); // offset to avoid always picking first
  const cta = pickFromPool(CTAS, index + 7); // different offset

  return (
    `<div>${closing} &nbsp;</div>` +
    `<div>${account.from_name} &nbsp;</div>` +
    `<div>${tagline} &nbsp;</div>` +
    `<div>${cta}</div>` +
    `<div><br></div>`
  );
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  console.log("=== Configure New Mailboxes ===\n");

  // Step 1: Pull all accounts from API
  console.log("1. Fetching all email accounts from SmartLead...");
  const allAccounts = await apiRequest("GET", "/email-accounts");
  console.log(`   Total accounts: ${allAccounts.length}`);

  // Step 2: Identify new accounts by domain
  const newAccounts = allAccounts.filter((a) => {
    const domain = a.from_email.split("@")[1];
    return NEW_DOMAINS.includes(domain);
  });

  console.log(
    `   New accounts (${NEW_DOMAINS.join(", ")}): ${newAccounts.length}`
  );
  if (newAccounts.length === 0) {
    console.log("   No new accounts found. Exiting.");
    return;
  }

  // Verify they're actually new: no warmup history, no campaign assignments
  console.log("\n2. Verifying new accounts have no history...");
  for (const a of newAccounts) {
    const wd = a.warmup_details || {};
    console.log(
      `   ${a.from_email}: warmup_sent=${wd.total_sent_count || 0}, ` +
        `daily_sent=${a.daily_sent_count}, type=${a.type}`
    );
  }

  // Step 3: Get sending config from an active account for reference
  console.log("\n3. Reading active account config for reference...");
  const activeGmail = allAccounts.find(
    (a) =>
      a.type === "GMAIL" &&
      a.warmup_details?.status === "ACTIVE" &&
      (a.warmup_details?.total_sent_count || 0) > 0
  );
  if (activeGmail) {
    const wd = activeGmail.warmup_details;
    console.log(`   Reference: ${activeGmail.from_email}`);
    console.log(
      `   Warmup: min=${wd.warmup_min_count}, max=${wd.warmup_max_count}, ` +
        `reply_rate=${wd.reply_rate}, max_email_per_day=${wd.max_email_per_day}`
    );
    console.log(`   message_per_day: ${activeGmail.message_per_day}`);
  }

  // Step 4: Configure each new account
  console.log("\n4. Configuring new accounts...\n");
  const results = [];

  for (let i = 0; i < newAccounts.length; i++) {
    const account = newAccounts[i];
    console.log(`--- ${account.from_email} (ID: ${account.id}) ---`);

    // Generate unique signature
    const signatureHtml = generateSignature(account, i);
    console.log(`   Signature generated.`);

    // SmartLead API uses POST /email-accounts/{id} for updates (not PATCH).
    // Accepted fields: max_email_per_day, signature, custom_tracking_domain,
    // bcc_email, different_reply_to_address, from_name.
    // Warmup on/off: POST /email-accounts/{id}/warmup with { warmup_enabled: bool }.
    // Warmup min/max/reply_rate are NOT settable via API — UI only.

    // Apply daily sending limit + signature
    console.log(`   Applying settings: max_email_per_day=5, signature...`);
    try {
      await apiRequest("POST", `/email-accounts/${account.id}`, {
        max_email_per_day: 5,
        signature: signatureHtml,
      });
      console.log(`   Settings applied.`);
    } catch (err) {
      console.error(`   ERROR applying settings: ${err.message}`);
      results.push({
        id: account.id,
        email: account.from_email,
        status: "FAILED",
        error: err.message,
      });
      continue;
    }

    // Ensure warmup is enabled
    console.log(`   Enabling warmup...`);
    try {
      await apiRequest("POST", `/email-accounts/${account.id}/warmup`, {
        warmup_enabled: true,
      });
      console.log(`   Warmup enabled.`);
    } catch (err) {
      console.error(`   WARNING: Warmup toggle failed: ${err.message}`);
    }

    // Verify by re-reading
    console.log(`   Verifying...`);
    const verified = await apiRequest(
      "GET",
      `/email-accounts/${account.id}`
    );
    const vwd = verified.warmup_details || {};

    const record = {
      id: verified.id,
      email: verified.from_email,
      name: verified.from_name,
      type: verified.type,
      status: "CONFIGURED",
      settings: {
        message_per_day: verified.message_per_day,
        daily_sent_count: verified.daily_sent_count,
        smtp_connected: verified.is_smtp_success,
        imap_connected: verified.is_imap_success,
      },
      warmup: {
        status: vwd.status || "UNKNOWN",
        min_count: vwd.warmup_min_count,
        max_count: vwd.warmup_max_count,
        max_email_per_day: vwd.max_email_per_day,
        reply_rate: vwd.reply_rate,
        total_sent: vwd.total_sent_count || 0,
      },
      signature_html: verified.signature,
      signature_preview: stripHtml(verified.signature),
    };

    results.push(record);
    console.log(`   Verified: msg/day=${verified.message_per_day}, ` +
      `warmup=${vwd.status}, sig=${verified.signature ? "SET" : "MISSING"}`);
    console.log();
  }

  // Step 5: Save report
  const report = {
    generated_at: new Date().toISOString(),
    new_domains: NEW_DOMAINS,
    accounts_configured: results.length,
    accounts_failed: results.filter((r) => r.status === "FAILED").length,
    settings_applied: {
      max_email_per_day: 5,
      warmup_enabled: true,
      signature: "SET (unique per account)",
      campaign_assignments: "NONE — do not assign until warmup complete",
    },
    manual_action_required: {
      warmup_min_count: "Set to 1 in SmartLead UI (not API-settable)",
      warmup_max_count: "Set to 5 in SmartLead UI (not API-settable)",
      warmup_reply_rate: "Set to 30% in SmartLead UI (not API-settable)",
    },
    accounts: results,
  };

  const outDir = projectPath("data", "reports");
  ensureDir(outDir);
  const outPath = projectPath("data", "reports", "new_mailbox_config.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n=== Configuration Complete ===`);
  console.log(`Report: ${outPath}`);
  console.log(
    `\nConfigured: ${results.filter((r) => r.status === "CONFIGURED").length}`
  );
  console.log(
    `Failed: ${results.filter((r) => r.status === "FAILED").length}`
  );

  // Print summary table
  console.log("\n--- Account Summary ---\n");
  for (const r of results) {
    if (r.status === "FAILED") {
      console.log(`  FAILED: ${r.email} — ${r.error}`);
      continue;
    }
    console.log(`  ${r.email}`);
    console.log(`    msg/day: ${r.settings.message_per_day} | warmup: ${r.warmup.status} (min=${r.warmup.min_count}, max=${r.warmup.max_count})`);
    console.log(`    smtp: ${r.settings.smtp_connected ? "OK" : "FAIL"} | imap: ${r.settings.imap_connected ? "OK" : "FAIL"}`);
    console.log(`    signature: ${r.signature_preview}`);
    console.log();
  }
}

function stripHtml(html) {
  if (!html) return "(none)";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
