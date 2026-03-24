/**
 * Dashboard Server
 *
 * Express server serving the outreach dashboard on port 7777.
 * Basic HTTP auth. Refreshes data on each page load.
 *
 * Usage: node scripts/dashboard-server.js
 * Env: DASHBOARD_PORT (default 7777), DASHBOARD_USER (default admin), DASHBOARD_PASS (required)
 */

const express = require("express");
const basicAuth = require("express-basic-auth");
const path = require("path");
const fs = require("fs");
const { projectPath } = require("../shared/utils");
const { refresh } = require("./refresh-dashboard");

const PORT = process.env.DASHBOARD_PORT || 7777;
const USER = process.env.DASHBOARD_USER || "admin";
const PASS = process.env.DASHBOARD_PASS;

if (!PASS) {
  console.error("DASHBOARD_PASS environment variable is required.");
  console.error("Set it in .env or export it before starting the server.");
  process.exit(1);
}

const app = express();

// Basic auth
app.use(basicAuth({
  users: { [USER]: PASS },
  challenge: true,
  realm: "OMG Outreach Dashboard",
}));

// GET / — refresh data, serve dashboard HTML
app.get("/", async (req, res) => {
  try {
    await refresh();
  } catch (err) {
    console.error("  [error] Refresh failed:", err.message);
    // Serve stale data if available
  }

  const htmlPath = projectPath("scripts", "dashboard.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(500).send("Dashboard HTML not found. Run the build first.");
  }
  res.sendFile(htmlPath);
});

// GET /api/data — serve dashboard JSON
app.get("/api/data", (req, res) => {
  const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: "No dashboard data. Visit / first to trigger refresh." });
  }
  res.sendFile(jsonPath);
});

// GET /api/hot-leads.csv — Wavv-ready CSV download
app.get("/api/hot-leads.csv", (req, res) => {
  const jsonPath = projectPath("data", "artifacts", "dashboard-data.json");
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).send("No data available");
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const leads = data.hotLeads || [];

  const header = "company,phone,email,score,reply_preview";
  const rows = leads.map(l => {
    const esc = (s) => `"${(s || "").replace(/"/g, '""')}"`;
    return `${esc(l.company)},${esc(l.phone)},${esc(l.email)},${l.score},${esc(l.replyPreview)}`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="hot_leads_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([header, ...rows].join("\n"));
});

app.listen(PORT, () => {
  console.log(`OMG Outreach Dashboard running at http://localhost:${PORT}`);
  console.log(`Auth: ${USER} / ****`);
});
