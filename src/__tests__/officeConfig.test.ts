import { describe, expect, it } from "vitest";
import { officeOrigin } from "../mcp/officeConfig";

describe("office connector configuration", () => {
  it("keeps the existing test default and accepts a separate production origin", () => {
    expect(officeOrigin()).toBe("https://schematic-mcp.tateside.online");
    expect(officeOrigin("https://schematic-mcp-production.tateside.online/")).toBe("https://schematic-mcp-production.tateside.online");
  });
  it.each(["http://example.test", "https://user:secret@example.test", "https://example.test/pair", "https://example.test?x=1", "https://example.test#x", "invalid"])("rejects unsafe origin %s", value => {
    expect(() => officeOrigin(value)).toThrow();
  });
});
