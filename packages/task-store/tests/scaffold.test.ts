import { describe, expect, it } from "vitest";
import { STORE_VERSION } from "../src/index.js";

describe("task-store scaffold", () => {
  it("exposes a version", () => {
    expect(STORE_VERSION).toBe("0.1.0");
  });
});