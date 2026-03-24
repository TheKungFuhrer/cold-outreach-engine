/**
 * Daily Email Summary
 *
 * Sends a mobile-friendly HTML email briefing from dashboard-data.json.
 * Uses Nodemailer with Gmail SMTP (app password).
 *
 * Usage:
 *   node scripts/daily-email.js --test    # send test email to yourself
 *   Programmatic: const { sendDailyEmail } = require('./daily-email'); await sendDailyEmail(data);
 *
 * Env: GMAIL_USER, GMAIL_APP_PASSWORD, BRYCE_EMAIL (optional), VPS_URL
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const nodemailer = require("nodemailer");
const path = require("path");
const { loadJson } = require("../shared/progress");
const { projectPath } = require("../shared/utils");

function buildSubject(data) {
  const replies = (data.hotLeads || []).length;
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const inCampaign = data.funnel?.stages?.find(s => s.name === "in_campaign")?.count || 0;
  return `OMG Outreach Daily — ${date} | ${replies} replies, ${inCampaign.toLocaleString()} in campaign`;
}

function fmt(n) { return (n || 0).toLocaleString(); }
function pct(n) { return ((n || 0) * 100).toFixed(1) + "%"; }

function buildHtml(data) {
  const vpsUrl = process.env.VPS_URL || "http://localhost:7777";

  // Pipeline snapshot
  const pipeline = (data.funnel?.stages || [])
    .map(s => `<strong>${s.name}:</strong> ${fmt(s.count)}`)
    .join(" &rarr; ");

  // Campaign table rows
  const campaignRows = (data.campaigns || []).map(c =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${c.name}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.sent)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.opened)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.replied)}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${fmt(c.bounced)}</td></tr>`
  ).join("");

  // Hot leads
  let hotSection = '<p style="color:#888">No new replies today.</p>';
  if (data.hotLeads && data.hotLeads.length > 0) {
    hotSection = data.hotLeads.map(l =>
      `<div style="background:#f8f9fa;border-radius:8px;padding:12px;margin-bottom:10px;border-left:4px solid #e94560">
        <div style="font-weight:bold;color:#1a1a2e">${l.company || "Unknown"} <span style="background:#e94560;color:#fff;padding:2px 6px;border-radius:10px;font-size:12px">${l.score}</span></div>
        <div><a href="tel:${l.phone}" style="color:#2563eb">${l.phone || "No phone"}</a> · ${l.email}</div>
        <div style="color:#666;font-style:italic;margin-top:4px;font-size:14px">"${(l.replyPreview || "").slice(0, 150)}"</div>
      </div>`
    ).join("");
  }

  // Action items
  const actions = [];
  if (data.hotLeads?.length > 0) {
    actions.push(`${data.hotLeads.length} hot lead${data.hotLeads.length > 1 ? "s" : ""} ready for Wavv import`);
  }
  const staleStages = (data.freshness?.stages || []).filter(s => s.unprocessedCount > 100 && s.oldestDays > 3);
  for (const s of staleStages) {
    actions.push(`${fmt(s.unprocessedCount)} leads sitting unprocessed in ${s.name} for ${s.oldestDays}+ days`);
  }
  if (actions.length === 0) {
    actions.push("Pipeline healthy, no action needed");
  }
  const actionHtml = actions.map(a => `<li style="margin-bottom:4px">${a}</li>`).join("");

  // Score distribution change (simplified — just show current)
  const scoreLine = data.scoreDistribution?.mean
    ? `<p style="color:#666;font-size:14px">Mean score: <strong>${data.scoreDistribution.mean}</strong> · Median: <strong>${data.scoreDistribution.median}</strong></p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">

  <!-- Header -->
  <div style="background:#1a1a2e;color:#fff;padding:20px 24px">
    <h1 style="margin:0;font-size:20px">OMG Outreach Daily</h1>
    <p style="margin:4px 0 0;color:#aaa;font-size:14px">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
  </div>

  <div style="padding:20px 24px">

    <!-- Pipeline Snapshot -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:0 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Pipeline Snapshot</h2>
    <p style="font-size:14px;line-height:1.6">${pipeline}</p>

    <!-- Campaign Performance -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Campaign Performance</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8f9fa">
        <th style="padding:6px 10px;text-align:left">Campaign</th>
        <th style="padding:6px 10px;text-align:center">Sent</th>
        <th style="padding:6px 10px;text-align:center">Opened</th>
        <th style="padding:6px 10px;text-align:center">Replied</th>
        <th style="padding:6px 10px;text-align:center">Bounced</th>
      </tr></thead>
      <tbody>${campaignRows}</tbody>
    </table>

    <!-- Hot Leads -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Hot Leads for Bryce</h2>
    ${hotSection}

    <!-- Score Distribution -->
    ${scoreLine ? `<h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Score Distribution</h2>${scoreLine}` : ""}

    <!-- Action Items -->
    <h2 style="font-size:16px;color:#1a1a2e;margin:20px 0 8px;border-bottom:2px solid #e94560;padding-bottom:4px">Action Items</h2>
    <ul style="margin:0;padding-left:20px;font-size:14px">${actionHtml}</ul>

  </div>

  <!-- Footer -->
  <div style="background:#f8f9fa;padding:16px 24px;text-align:center;font-size:13px;color:#888">
    <a href="${vpsUrl}" style="color:#2563eb;text-decoration:none">View Full Dashboard &rarr;</a>
  </div>

</div>
</body>
</html>`;
}

async function sendDailyEmail(data) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.warn("  [warn] GMAIL_USER and GMAIL_APP_PASSWORD required for email. Skipping.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: gmailUser, pass: gmailPass },
  });

  const subject = buildSubject(data);
  const html = buildHtml(data);

  const mailOptions = {
    from: gmailUser,
    to: gmailUser,
    subject,
    html,
  };

  // CC Bryce only when there are hot leads
  const bryceEmail = process.env.BRYCE_EMAIL;
  if (bryceEmail && data.hotLeads && data.hotLeads.length > 0) {
    mailOptions.cc = bryceEmail;
  }

  const info = await transporter.sendMail(mailOptions);
  console.log(`  [ok] Daily email sent: ${info.messageId}`);
  if (mailOptions.cc) {
    console.log(`  [ok] CC'd ${bryceEmail} (${data.hotLeads.length} hot leads)`);
  }
  return info;
}

module.exports = { sendDailyEmail, buildSubject, buildHtml };

// CLI entry point
if (require.main === module) {
  const isTest = process.argv.includes("--test");

  (async () => {
    // Load dashboard data
    const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
    let data = loadJson(jsonPath);

    if (!data) {
      console.log("No dashboard data found. Running refresh first...");
      const { refresh } = require("./refresh-dashboard");
      data = await refresh();
    }

    if (isTest) {
      console.log("Sending test email...");
      // Force no CC for test
      delete process.env.BRYCE_EMAIL;
    }

    await sendDailyEmail(data);
  })().catch(err => {
    console.error("Email failed:", err.message);
    process.exit(1);
  });
}
