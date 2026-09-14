import { describe, expect, it } from "vitest";
import {
  applyCollectionPolicy,
  applySourceMappings,
  crossSourceDuplicateReasons,
  eventSourceIdentity,
  reviewSnapshotAction,
} from "../../scripts/cli/collection-policy";
import { eventSchema, sourceDefinitionSchema, type EventRecord } from "../../src/lib/schema";

function event(sourceId: string, externalId: string, title = "Samme arrangement"): EventRecord {
  return eventSchema.parse({
    id: `${sourceId}-${externalId}`,
    title,
    organizerId: "arrangoer",
    categoryIds: ["andet"],
    schedule: { kind: "explicit", dates: [{ kind: "timed", date: "2026-11-04", startTime: "19:00" }] },
    source: { sourceId, externalId },
  });
}

const automaticSource = sourceDefinitionSchema.parse({
  id: "source-a",
  name: "A",
  publication: "automatic",
  enabled: true,
});
const reviewSource = sourceDefinitionSchema.parse({
  id: "source-a",
  name: "A",
  publication: "review",
  enabled: true,
});

describe("final collection policy", () => {
  it("allows auto-publication only when YAML policy and adapter both allow it", () => {
    expect(applyCollectionPolicy(automaticSource, "trusted", [], false).publication).toBe("published");
    expect(applyCollectionPolicy(reviewSource, "trusted", [], false).publication).toBe("draft");
    expect(applyCollectionPolicy(automaticSource, "review", [], false).publication).toBe("draft");
    expect(applyCollectionPolicy(automaticSource, "trusted", ["dublet"], false).publication).toBe("draft");
    expect(applyCollectionPolicy(automaticSource, "trusted", [], true).publication).toBe("draft");
    expect(applyCollectionPolicy(automaticSource, "trusted", [], false, true).publication).toBe("draft");
  });

  it("preserves the event organizer while applying category mappings from YAML", () => {
    const mappedSource = sourceDefinitionSchema.parse({
      ...automaticSource,
      organizerId: "yaml-arrangoer",
      categoryIds: ["yaml-kategori"],
    });
    expect(applySourceMappings(event("source-a", "one"), mappedSource)).toMatchObject({
      organizerId: "arrangoer",
      categoryIds: ["yaml-kategori"],
    });
  });

  it("marks every side of a same-run cross-source duplicate independent of order", () => {
    const sourceA = event("source-a", "one");
    const sourceB = event("source-b", "two");
    for (const candidates of [[sourceA, sourceB], [sourceB, sourceA]]) {
      const reasons = crossSourceDuplicateReasons([], candidates);
      expect(reasons.get(eventSourceIdentity(sourceA))?.join(" ")).toContain("source-b-two");
      expect(reasons.get(eventSourceIdentity(sourceB))?.join(" ")).toContain("source-a-one");
    }
  });

  it("does not treat lookalikes from one source as cross-source duplicates", () => {
    const first = event("source-a", "one");
    const second = event("source-a", "two");
    expect(crossSourceDuplicateReasons([], [first, second])).toEqual(new Map());
  });

  it("does not expose changed review payloads through an older publication override", () => {
    expect(reviewSnapshotAction(false, "updated")).toBe("retain-demoted");
    expect(reviewSnapshotAction(false, "already-pending")).toBe("retain-demoted");
    expect(reviewSnapshotAction(false, "rejected")).toBe("retain-demoted");
    expect(reviewSnapshotAction(false, "created", true)).toBe("retain-demoted");
    expect(reviewSnapshotAction(false, "created")).toBe("observe-draft");
    expect(reviewSnapshotAction(false, "approved")).toBe("observe-draft");
    expect(reviewSnapshotAction(true, "approved")).toBe("remove");
  });
});
