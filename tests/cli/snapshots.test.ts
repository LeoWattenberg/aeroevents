import { describe, expect, it } from "vitest";
import { mergeSourceEvents } from "../../scripts/cli/snapshots";
import { eventSchema, type EventRecord } from "../../src/lib/schema";

function event(id: string, externalId: string, date: string, status: "scheduled" | "cancelled" = "scheduled"): EventRecord {
  return eventSchema.parse({
    id,
    title: id,
    organizerId: "aeroe-kommune",
    categoryIds: ["politik-kommune"],
    status,
    schedule: { kind: "explicit", dates: [{ kind: "timed", date, startTime: "17:00" }] },
    source: { sourceId: "aeroe-kommune", externalId },
  });
}

describe("source snapshot merge", () => {
  it("retains entries absent from a later source window", () => {
    const oldPast = event("meeting-old", "old", "2026-01-01");
    const future = event("meeting-future", "future", "2027-01-01");
    const observed = event("meeting-new", "new", "2026-11-01");
    expect(mergeSourceEvents([oldPast, future], [observed]).map((item) => item.id)).toEqual([
      "meeting-old",
      "meeting-future",
      "meeting-new",
    ]);
  });

  it("replaces an explicitly seen identity, including cancellation", () => {
    const scheduled = event("meeting-one", "one", "2026-11-01");
    const cancelled = event("meeting-one", "one", "2026-11-01", "cancelled");
    expect(mergeSourceEvents([scheduled], [cancelled])).toEqual([cancelled]);
  });

  it("rejects duplicate source identities in one response", () => {
    const first = event("meeting-one", "same", "2026-11-01");
    const second = event("meeting-two", "same", "2026-11-02");
    expect(() => mergeSourceEvents([], [first, second])).toThrow(/samme eksterne event-id/);
  });

  it("replaces a formerly public observed record with its review-only draft", () => {
    const published = event("meeting-one", "one", "2026-11-01");
    const reviewOnly = { ...published, publication: "draft" as const };
    expect(mergeSourceEvents([published], [reviewOnly])).toEqual([reviewOnly]);
  });

  it("demotes invalid observed records and removes editor-owned identities", () => {
    const invalidNow = event("meeting-one", "one", "2026-11-01");
    const editorOwned = event("meeting-two", "two", "2026-11-02");
    expect(
      mergeSourceEvents([invalidNow, editorOwned], [], {
        demoteIdentities: new Set(["one"]),
        removeIdentities: new Set(["two"]),
      }),
    ).toEqual([{ ...invalidNow, publication: "draft" }]);
  });

  it("backfills a retained legacy event with its old snapshot verification time", () => {
    const legacy = event("meeting-old", "old", "2026-01-01");
    expect(legacy.source.verifiedAt).toBeUndefined();
    const [retained] = mergeSourceEvents([legacy], [], {
      previousVerifiedAt: "2026-09-10T10:00:00Z",
    });
    expect(retained?.source.verifiedAt).toBe("2026-09-10T10:00:00Z");
  });
});
