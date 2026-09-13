import { describe, expect, it } from "vitest";
import { buildApprovalOverride } from "../../scripts/cli/editorial";
import { eventSchema } from "../../src/lib/schema";

const base = eventSchema.parse({
  id: "source-a-one",
  title: "Titel",
  organizerId: "arrangoer",
  categoryIds: ["andet"],
  publication: "draft",
  schedule: { kind: "explicit", dates: [{ kind: "timed", date: "2026-11-04", startTime: "19:00" }] },
  source: { sourceId: "source-a", externalId: "one", verifiedAt: "2026-09-13T10:00:00Z" },
});

describe("approval override", () => {
  it("publishes an unchanged review base without freezing source-managed fields", () => {
    const approved = eventSchema.parse({ ...base, publication: "published" });
    expect(buildApprovalOverride(approved, base)).toEqual({
      eventId: "source-a-one",
      set: { publication: "published" },
    });
  });

  it("persists fields the editor actually changed", () => {
    const approved = eventSchema.parse({ ...base, title: "Rettet titel", publication: "published" });
    expect(buildApprovalOverride(approved, base).set).toEqual({
      title: "Rettet titel",
      publication: "published",
    });
  });
});

