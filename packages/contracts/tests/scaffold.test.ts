import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../src/index.js";

describe("handoff-contract scaffold", () => {
  it("exposes a version", () => {
    expect(CONTRACT_VERSION).toBe("1");
  });
});