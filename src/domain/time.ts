/** ISO 8601 UTC with seconds precision, matching the spec example ("2026-07-27T12:01:00Z"). */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
