import { describe, it, expect } from "vitest";
import { parseName } from "./fields.js";

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
