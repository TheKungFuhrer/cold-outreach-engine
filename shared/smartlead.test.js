import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Mock fetch globally before requiring the module
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Stub env to avoid needing real API key
vi.stubEnv("SMARTLEAD_API_KEY", "test-key-123");

const { getCampaignLeads, getLeadMessageHistory } = require("./smartlead");

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getCampaignLeads", () => {
  it("paginates through all leads and returns combined array", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      email: `lead${i}@test.com`,
      sent_count: 1,
    }));
    const page2 = [{ id: 100, email: "lead100@test.com", sent_count: 1 }];

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page1),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(page2),
      });

    const result = await getCampaignLeads(12345);
    expect(result).toHaveLength(101);
    expect(result[0].email).toBe("lead0@test.com");
    expect(result[100].email).toBe("lead100@test.com");

    // Verify pagination params in URLs
    const url1 = mockFetch.mock.calls[0][0];
    expect(url1).toContain("/campaigns/12345/leads");
    expect(url1).toContain("offset=0");
    const url2 = mockFetch.mock.calls[1][0];
    expect(url2).toContain("offset=100");
  });

  it("stops pagination when empty array returned", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    });

    const result = await getCampaignLeads(12345);
    expect(result).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("getLeadMessageHistory", () => {
  it("returns message history for a lead", async () => {
    const messages = [
      { type: "SENT", body: "Hi there", time: "2026-03-20T10:00:00Z" },
      { type: "REPLY", body: "Interested!", time: "2026-03-21T14:00:00Z" },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(messages),
    });

    const result = await getLeadMessageHistory(12345, 99);
    expect(result).toHaveLength(2);
    expect(result[1].body).toBe("Interested!");

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain("/campaigns/12345/leads/99/message-history");
  });
});
