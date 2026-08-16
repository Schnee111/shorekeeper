import { describe, expect, it } from "vitest";
import { BRIDGE_VERSION } from "../src/index.js";

describe("omp-bridge scaffold", () => {
  it("exposes a version", () => {
    expect(BRIDGE_VERSION).toBe("0.1.0");
  });
});