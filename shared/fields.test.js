import { describe, it, expect } from "vitest";
import { parseName, parseLocationFull } from "./fields.js";

describe("parseName", () => {
  it("splits simple two-part name", () => {
    expect(parseName("John Smith")).toEqual({ first: "John", last: "Smith" });
  });

  it("strips prefix", () => {
    expect(parseName("Dr. Jane Doe")).toEqual({ first: "Jane", last: "Doe" });
  });

  it("handles multi-part first name", () => {
    expect(parseName("Mary Jane Watson")).toEqual({ first: "Mary", last: "Jane Watson" });
  });

  it("single token goes to first name", () => {
    expect(parseName("Smith")).toEqual({ first: "Smith", last: "" });
  });

  it("empty string returns empty", () => {
    expect(parseName("")).toEqual({ first: "", last: "" });
  });

  it("strips Jr. suffix", () => {
    expect(parseName("John Smith Jr.")).toEqual({ first: "John", last: "Smith" });
  });

  it("strips Sr. suffix", () => {
    expect(parseName("Robert Jones Sr.")).toEqual({ first: "Robert", last: "Jones" });
  });

  it("strips III suffix", () => {
    expect(parseName("William Davis III")).toEqual({ first: "William", last: "Davis" });
  });

  it("strips PhD suffix", () => {
    expect(parseName("Jane Doe PhD")).toEqual({ first: "Jane", last: "Doe" });
  });

  it("strips prefix AND suffix", () => {
    expect(parseName("Dr. John Smith Jr.")).toEqual({ first: "John", last: "Smith" });
  });

  it("returns empty for company names", () => {
    expect(parseName("Grand Resort LLC")).toEqual({ first: "", last: "" });
  });

  it("handles null", () => {
    expect(parseName(null)).toEqual({ first: "", last: "" });
  });
});

describe("parseLocationFull", () => {
  it("parses City, ST", () => {
    expect(parseLocationFull("Austin, TX")).toEqual({ city: "Austin", state: "TX", zip: "" });
  });

  it("parses City, ST ZIP", () => {
    expect(parseLocationFull("Austin, TX 78701")).toEqual({ city: "Austin", state: "TX", zip: "78701" });
  });

  it("parses full state name", () => {
    expect(parseLocationFull("New York, New York")).toEqual({ city: "New York", state: "NY", zip: "" });
  });

  it("parses City ST ZIP without comma", () => {
    expect(parseLocationFull("Miami FL 33101")).toEqual({ city: "Miami", state: "FL", zip: "33101" });
  });

  it("handles ZIP+4 (keeps only 5 digits)", () => {
    expect(parseLocationFull("Dallas, TX 75201-1234")).toEqual({ city: "Dallas", state: "TX", zip: "75201" });
  });

  it("strips trailing USA", () => {
    expect(parseLocationFull("Seattle, WA 98101, USA")).toEqual({ city: "Seattle", state: "WA", zip: "98101" });
  });

  it("strips trailing United States", () => {
    expect(parseLocationFull("Portland, OR, United States")).toEqual({ city: "Portland", state: "OR", zip: "" });
  });

  it("handles extra whitespace", () => {
    expect(parseLocationFull("  Denver ,  CO  80202  ")).toEqual({ city: "Denver", state: "CO", zip: "80202" });
  });

  it("returns empty for null", () => {
    expect(parseLocationFull(null)).toEqual({ city: "", state: "", zip: "" });
  });

  it("returns empty for empty string", () => {
    expect(parseLocationFull("")).toEqual({ city: "", state: "", zip: "" });
  });

  it("returns city only when no state match", () => {
    expect(parseLocationFull("Some Place")).toEqual({ city: "Some Place", state: "", zip: "" });
  });

  it("handles state code only", () => {
    expect(parseLocationFull("CA")).toEqual({ city: "", state: "CA", zip: "" });
  });

  it("handles full state name California", () => {
    expect(parseLocationFull("Los Angeles, California")).toEqual({ city: "Los Angeles", state: "CA", zip: "" });
  });

  it("handles District of Columbia", () => {
    expect(parseLocationFull("Washington, District of Columbia")).toEqual({ city: "Washington", state: "DC", zip: "" });
  });
});
