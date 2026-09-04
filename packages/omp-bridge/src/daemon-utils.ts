/**
 * daemon-utils.ts — pure utility functions for daemon execution and stream aggregation.
 */

export interface HermesResult {
  ok: boolean;
  summary: string;
}

/** Potong summary ke ≤ 190 kata (limit store: 200 kata). */
export function clipSummary(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 190) return words.join(" ") || "(tanpa ringkasan)";
  return words.slice(0, 190).join(" ") + "…";
}

/** Build WebSocket URL with token parameter. */
export function buildWsUrl(baseUrl: string, token: string): string {
  if (!token) return baseUrl;
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
}
