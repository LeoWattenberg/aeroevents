import { describe, expect, it } from "vitest";
import { findEventDuplicates, titleSimilarity } from "../../scripts/cli/duplicate-finder";
import { eventSchema, occurrenceSchema, type EventRecord, type Occurrence } from "../../src/lib/schema";

function event(id: string, title: string, sourceId = "source-a", location = "Motorfabrikken Marstal"): EventRecord {
  return eventSchema.parse({
    id,
    title,
    organizerId: "arrangoer",
    categoryIds: ["andet"],
    location: { name: location },
    schedule: { kind: "explicit", dates: [{ kind: "timed", date: "2026-10-04", startTime: "19:00" }] },
    source: { sourceId, externalId: id },
  });
}

function occurrence(eventId: string, date: string, time?: string): Occurrence {
  return occurrenceSchema.parse({
    id: `${eventId}-${date}-${time || "unknown"}`,
    eventId,
    recurrenceId: `${date}T${time || "unknown"}`,
    date,
    ...(time ? { startAt: `${date}T${time}:00.000+02:00` } : {}),
    allDay: false,
    timeUnknown: !time,
    status: "scheduled",
  });
}

describe("duplicate finder", () => {
  it("normalizes Danish letters, punctuation and title additions", () => {
    expect(titleSimilarity("Ærø Jazz & Blues", "Aeroe jazz og blues")).toBe(1);
    expect(titleSimilarity("Johnny Hansen", "Koncert med Johnny Hansen")).toBeGreaterThanOrEqual(0.85);
  });

  it("finds near-title pairs on a shared date within the time tolerance", () => {
    const left = event("johnny-hansen", "Johnny Hansen");
    const right = event("koncert-johnny", "Koncert med Johnny Hansen", "source-b");
    const matches = findEventDuplicates(
      [left, right],
      [occurrence(left.id, "2026-10-04", "19:00"), occurrence(right.id, "2026-10-04", "19:20")],
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      left: { id: "johnny-hansen" },
      right: { id: "koncert-johnny" },
      sharedStarts: [{ date: "2026-10-04", differenceMinutes: 20 }],
    });
  });

  it("connects all three known Emma Pilgaard catalog records", () => {
    const campus = event(
      "campus-aeroe-8001",
      "Åbning af Sundhedsfestival – Årets Fynske Jazzmusiker Emma Pilgaard",
      "campus-aeroe",
    );
    const manual = event(
      "facebook-post-manual",
      "Gratis Koncert med Emma Pilgaard - Årets Fynske Jazzmusiker",
      "facebook",
    );
    const imported = event(
      "facebook-post-imported",
      "Gratis Koncert med Emma Pilgaard - Årets Fynske Jazzmusiker",
      "facebook",
    );
    const events = [campus, manual, imported];
    const starts = events.map((item) => occurrence(item.id, "2026-09-14", "18:00"));

    const matches = findEventDuplicates(events, starts);

    expect(matches).toHaveLength(3);
    expect(new Set(matches.flatMap((match) => [match.left.id, match.right.id]))).toEqual(
      new Set([campus.id, manual.id, imported.id]),
    );
  });

  it("does not match different dates or times beyond the tolerance", () => {
    const left = event("first", "Keramik workshop");
    const right = event("second", "Keramik-workshop");

    expect(findEventDuplicates(
      [left, right],
      [occurrence(left.id, "2026-10-04", "19:00"), occurrence(right.id, "2026-10-05", "19:00")],
    )).toEqual([]);
    expect(findEventDuplicates(
      [left, right],
      [occurrence(left.id, "2026-10-04", "19:00"), occurrence(right.id, "2026-10-04", "20:00")],
    )).toEqual([]);
  });

  it("finds same-source duplicates and permits a stricter custom threshold", () => {
    const left = event("first", "Fælles arrangement");
    const right = event("second", "Fælles arrangement");
    const starts = [occurrence(left.id, "2026-10-04"), occurrence(right.id, "2026-10-04", "19:00")];

    expect(findEventDuplicates([left, right], starts)).toHaveLength(1);
    expect(findEventDuplicates([left, right], starts, { minimumTitleSimilarity: 1 })).toHaveLength(1);
  });

  it("rejects a moderate title match when the venues disagree", () => {
    const left = event("rise", "Gudstjeneste Rise", "churchdesk", "Rise Kirke");
    const right = event("bregninge", "Gudstjeneste Bregninge", "churchdesk", "Bregninge Kirke");
    const starts = [occurrence(left.id, "2026-10-04", "10:00"), occurrence(right.id, "2026-10-04", "10:00")];

    expect(findEventDuplicates([left, right], starts)).toEqual([]);
  });
});
