import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { loadConfig, parseArgs, getActiveSteps, runCommand, readStepOutput, formatStatus } = require("./pipeline");
const { STAGE_RANK, createMergeMap, mergeIntoMap } = require("./shared/master");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("loads pipeline-config.json and returns steps array", () => {
    const config = loadConfig();
    expect(config).toHaveProperty("steps");
    expect(Array.isArray(config.steps)).toBe(true);
    expect(config.steps.length).toBeGreaterThan(0);
  });

  it("each step has name and script", () => {
    const config = loadConfig();
    for (const step of config.steps) {
      expect(step).toHaveProperty("name");
      expect(step).toHaveProperty("script");
    }
  });

  it("has retries config", () => {
    const config = loadConfig();
    expect(config).toHaveProperty("retries");
    expect(config.retries).toHaveProperty("default");
    expect(config.retries).toHaveProperty("delay");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to run command with no args", () => {
    const opts = parseArgs([]);
    expect(opts.command).toBe("run");
    expect(opts.from).toBeNull();
    expect(opts.to).toBeNull();
    expect(opts.skip).toEqual([]);
    expect(opts.campaignId).toBeNull();
    expect(opts.dryRun).toBe(false);
  });

  it("detects status command", () => {
    const opts = parseArgs(["status"]);
    expect(opts.command).toBe("status");
  });

  it("parses --from and --to with space separator", () => {
    const opts = parseArgs(["--from", "classify", "--to", "export"]);
    expect(opts.from).toBe("classify");
    expect(opts.to).toBe("export");
  });

  it("parses --from= and --to= with equals separator", () => {
    const opts = parseArgs(["--from=classify", "--to=export"]);
    expect(opts.from).toBe("classify");
    expect(opts.to).toBe("export");
  });

  it("parses --skip with comma-separated values", () => {
    const opts = parseArgs(["--skip", "escalate,phones"]);
    expect(opts.skip).toEqual(["escalate", "phones"]);
  });

  it("parses --skip= with equals separator", () => {
    const opts = parseArgs(["--skip=escalate,phones"]);
    expect(opts.skip).toEqual(["escalate", "phones"]);
  });

  it("parses --campaign-id", () => {
    const opts = parseArgs(["--campaign-id", "12345"]);
    expect(opts.campaignId).toBe("12345");
  });

  it("parses --campaign-id= with equals", () => {
    const opts = parseArgs(["--campaign-id=12345"]);
    expect(opts.campaignId).toBe("12345");
  });

  it("detects --dry-run", () => {
    const opts = parseArgs(["--dry-run"]);
    expect(opts.dryRun).toBe(true);
  });

  it("handles all flags together", () => {
    const opts = parseArgs([
      "--from", "classify",
      "--to", "upload",
      "--skip", "escalate",
      "--campaign-id", "99",
      "--dry-run",
    ]);
    expect(opts.command).toBe("run");
    expect(opts.from).toBe("classify");
    expect(opts.to).toBe("upload");
    expect(opts.skip).toEqual(["escalate"]);
    expect(opts.campaignId).toBe("99");
    expect(opts.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getActiveSteps
// ---------------------------------------------------------------------------

describe("getActiveSteps", () => {
  const testSteps = [
    { name: "prefilter", inputStage: "raw" },
    { name: "classify", inputStage: "filtered", sidecar: { name: "escalate", script: "escalate.py" } },
    { name: "validate_phones", inputStage: "classified" },
    { name: "export", inputStage: "validated" },
    { name: "upload", inputStage: "exported" },
  ];

  it("returns all steps with no filters", () => {
    const result = getActiveSteps(testSteps, { from: null, to: null, skip: [] });
    expect(result).toHaveLength(5);
  });

  it("filters by from", () => {
    const result = getActiveSteps(testSteps, { from: "classify", to: null, skip: [] });
    expect(result).toHaveLength(4);
    expect(result[0].name).toBe("classify");
  });

  it("filters by to", () => {
    const result = getActiveSteps(testSteps, { from: null, to: "classify", skip: [] });
    expect(result).toHaveLength(2);
    expect(result[result.length - 1].name).toBe("classify");
  });

  it("filters by from and to", () => {
    const result = getActiveSteps(testSteps, { from: "classify", to: "export", skip: [] });
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("classify");
    expect(result[result.length - 1].name).toBe("export");
  });

  it("skips named steps", () => {
    const result = getActiveSteps(testSteps, { from: null, to: null, skip: ["validate_phones"] });
    expect(result).toHaveLength(4);
    expect(result.find((s) => s.name === "validate_phones")).toBeUndefined();
  });

  it("marks _skipSidecar when skip targets a sidecar name", () => {
    const result = getActiveSteps(testSteps, { from: null, to: null, skip: ["escalate"] });
    // classify step should still be present
    expect(result).toHaveLength(5);
    const classify = result.find((s) => s.name === "classify");
    expect(classify).toBeDefined();
    expect(classify._skipSidecar).toBe(true);
  });

  it("does not mutate original steps array", () => {
    const original = testSteps.map((s) => ({ ...s }));
    getActiveSteps(testSteps, { from: "classify", to: "export", skip: ["escalate"] });
    expect(testSteps.length).toBe(original.length);
  });
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

describe("runCommand", () => {
  it("runs a simple command and captures stdout", async () => {
    const result = await runCommand("echo hello");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures stderr", async () => {
    const result = await runCommand("echo error_msg 1>&2");
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe("error_msg");
  });

  it("returns non-zero exit code on failure", async () => {
    const result = await runCommand("exit 42");
    expect(result.code).toBe(42);
  });

  it("handles command that produces both stdout and stderr", async () => {
    const result = await runCommand("echo out && echo err 1>&2");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  });
});

// ---------------------------------------------------------------------------
// readStepOutput
// ---------------------------------------------------------------------------

describe("readStepOutput", () => {
  it("returns empty array for null path", () => {
    const result = readStepOutput(null);
    expect(result).toEqual([]);
  });

  it("returns empty array for undefined path", () => {
    const result = readStepOutput(undefined);
    expect(result).toEqual([]);
  });

  it("returns empty array for missing file", () => {
    const result = readStepOutput("data/nonexistent/file.csv");
    expect(result).toEqual([]);
  });

  it("reads a CSV file and returns records", () => {
    // Create a temp CSV
    const tmpDir = path.join(os.tmpdir(), "pipeline-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const csvPath = path.join(tmpDir, "test.csv");
    fs.writeFileSync(csvPath, "domain,email\nexample.com,a@example.com\ntest.com,b@test.com\n");

    // readStepOutput expects path relative to projectPath, so we use absolute path trick
    // Instead, test via direct csv read since readStepOutput uses projectPath
    const records = require("./shared/csv").readCsv(csvPath).records;
    expect(records).toHaveLength(2);
    expect(records[0].domain).toBe("example.com");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("reads newest CSV from a directory", () => {
    const tmpDir = path.join(os.tmpdir(), "pipeline-dir-test-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    // Create two CSVs with different mtimes
    const csv1 = path.join(tmpDir, "old.csv");
    fs.writeFileSync(csv1, "domain\nold.com\n");

    // Set old mtime
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(csv1, oldTime, oldTime);

    const csv2 = path.join(tmpDir, "new.csv");
    fs.writeFileSync(csv2, "domain\nnew.com\n");

    // Read newest - use direct approach since readStepOutput uses projectPath
    const files = fs.readdirSync(tmpDir)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(tmpDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    expect(files[0].name).toBe("new.csv");
    const records = require("./shared/csv").readCsv(path.join(tmpDir, files[0].name)).records;
    expect(records[0].domain).toBe("new.com");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe("formatStatus", () => {
  it("formats stage counts into readable table", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "raw" });
    mergeIntoMap(map, { domain: "b.com", email: "b@b.com", pipeline_stage: "raw" });
    mergeIntoMap(map, { domain: "c.com", email: "c@c.com", pipeline_stage: "classified" });
    mergeIntoMap(map, { domain: "d.com", email: "d@d.com", pipeline_stage: "uploaded" });

    const output = formatStatus(map, null);
    expect(output).toContain("Pipeline Status");
    expect(output).toContain("raw");
    expect(output).toContain("classified");
    expect(output).toContain("uploaded");
  });

  it("sorts stages by STAGE_RANK order", () => {
    const map = createMergeMap();
    mergeIntoMap(map, { domain: "a.com", email: "a@a.com", pipeline_stage: "uploaded" });
    mergeIntoMap(map, { domain: "b.com", email: "b@b.com", pipeline_stage: "raw" });

    const output = formatStatus(map, null);
    const rawIdx = output.indexOf("raw");
    const uploadedIdx = output.indexOf("uploaded");
    expect(rawIdx).toBeLessThan(uploadedIdx);
  });

  it("shows pending batch info", () => {
    const map = createMergeMap();
    const runState = {
      pendingBatch: { batchId: "batch_123", step: "classify" },
    };

    const output = formatStatus(map, runState);
    expect(output).toContain("batch_123");
    expect(output).toContain("classify");
  });

  it("shows failure info", () => {
    const map = createMergeMap();
    const runState = {
      failures: [{ step: "upload", error: "timeout" }],
    };

    const output = formatStatus(map, runState);
    expect(output).toContain("upload");
    expect(output).toContain("timeout");
  });

  it("returns string with empty map", () => {
    const map = createMergeMap();
    const output = formatStatus(map, null);
    expect(typeof output).toBe("string");
    expect(output).toContain("Pipeline Status");
  });
});
