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
