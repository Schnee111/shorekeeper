import { describe, it, expect } from "vitest";
import { clipSummary } from "../src/daemon-utils.js";

describe("clipSummary", () => {
  it("preserves short text under 190 words", () => {
    const text = "Aktivitas GitHub kemarin: 5 commits pada repository shorekeeper.";
    expect(clipSummary(text)).toBe(text);
  });

  it("returns fallback for empty text", () => {
    expect(clipSummary("")).toBe("(tanpa ringkasan)");
    expect(clipSummary("   \n\t ")).toBe("(tanpa ringkasan)");
  });

  it("clips text exceeding 190 words to 190 words with ellipsis", () => {
    const words = Array.from({ length: 250 }, (_, i) => `word${i + 1}`);
    const longText = words.join(" ");
    const clipped = clipSummary(longText);
    const clippedWords = clipped.replace(/…$/, "").trim().split(/\s+/);
    expect(clippedWords.length).toBe(190);
    expect(clipped.endsWith("…")).toBe(true);
    // Verified under summaryMaxWords (200)
    expect(clipped.trim().split(/\s+/).length).toBeLessThanOrEqual(200);
  });
});
