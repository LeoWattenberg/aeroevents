import { DateTime, Settings } from "luxon";
import { describe, expect, it } from "vitest";
import { eventDateSchema, type EventRecord } from "../src/lib/schema";
import { CALENDAR_ZONE, expandEvent } from "../src/lib/schedule";

const base: Omit<EventRecord, "id" | "title" | "schedule"> = {
  description: "",
  organizerId: "aeroe-kalenderen",
  categoryIds: ["andet"],
  attendance: { kind: "public" },
  status: "scheduled",
  publication: "published",
  source: { sourceId: "manual" },
};

const range = (start: string, end: string) => [
  DateTime.fromISO(start, { zone: CALENDAR_ZONE }),
  DateTime.fromISO(end, { zone: CALENDAR_ZONE }),
] as const;

describe("expandEvent", () => {
  it("keeps Copenhagen wall time across the spring DST change", () => {
    const event: EventRecord = {
      ...base,
      id: "weekly",
      title: "Ugentlig",
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2027-03-21", startTime: "09:00" },
        rrule: "FREQ=WEEKLY;COUNT=3",
        rdates: [],
        exdates: [],
        overrides: [],
        durationMinutes: 60,
      },
    };
    const [from, to] = range("2027-03-20", "2027-04-10");
    const result = expandEvent(event, from, to);

    expect(result.warnings).toEqual([]);
    expect(result.occurrences.map((item) => item.startAt)).toEqual([
      "2027-03-21T09:00:00.000+01:00",
      "2027-03-28T09:00:00.000+02:00",
      "2027-04-04T09:00:00.000+02:00",
    ]);
  });

  it("skips a nonexistent local clock time and reports it", () => {
    const event: EventRecord = {
      ...base,
      id: "missing-hour",
      title: "Manglende time",
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2027-03-28", startTime: "02:30" },
        rrule: "FREQ=DAILY;COUNT=1",
        rdates: [],
        exdates: [],
        overrides: [],
      },
    };
    const [from, to] = range("2027-03-28", "2027-03-28");
    const result = expandEvent(event, from, to);

    expect(result.occurrences).toEqual([]);
    expect(result.warnings[0]).toContain("findes ikke");
  });

  it("chooses the earlier instant for an ambiguous autumn clock time", () => {
    const event: EventRecord = {
      ...base,
      id: "double-hour",
      title: "Dobbelt time",
      schedule: {
        kind: "explicit",
        dates: [{ kind: "timed", date: "2026-10-25", startTime: "02:30" }],
      },
    };
    const [from, to] = range("2026-10-25", "2026-10-25");
    const [occurrence] = expandEvent(event, from, to).occurrences;

    expect(occurrence?.startAt).toBe("2026-10-25T02:30:00.000+02:00");
  });

  it("applies exclusions and preserves identity when an occurrence moves", () => {
    const event: EventRecord = {
      ...base,
      id: "monthly",
      title: "Månedlig",
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-09-01", startTime: "19:00" },
        rrule: "FREQ=MONTHLY;COUNT=4",
        rdates: [],
        exdates: ["2026-10-01T19:00"],
        overrides: [
          {
            recurrenceId: "2026-11-01T19:00",
            replacement: { kind: "timed", date: "2026-11-03", startTime: "20:00" },
          },
        ],
      },
    };
    const [from, to] = range("2026-09-01", "2026-12-31");
    const result = expandEvent(event, from, to);

    expect(result.occurrences.map((item) => [item.recurrenceId, item.date])).toEqual([
      ["2026-09-01T19:00", "2026-09-01"],
      ["2026-11-01T19:00", "2026-11-03"],
      ["2026-12-01T19:00", "2026-12-01"],
    ]);
    expect(result.occurrences[1]?.id).toBe("monthly--2026-11-01T1900");
  });

  it("includes moved-in occurrences and excludes replacements moved beyond the expansion window", () => {
    const event: EventRecord = {
      ...base,
      id: "moved-across-window",
      title: "Flyttet over vinduet",
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-09-01", startTime: "19:00" },
        rrule: "FREQ=MONTHLY;COUNT=4",
        rdates: [],
        exdates: [],
        overrides: [
          {
            recurrenceId: "2026-09-01T19:00",
            replacement: { kind: "timed", date: "2027-01-10", startTime: "19:00" },
          },
          {
            recurrenceId: "2026-12-01T19:00",
            replacement: { kind: "timed", date: "2026-10-15", startTime: "20:00" },
          },
        ],
      },
    };
    const [from, to] = range("2026-09-01", "2026-11-30");
    const result = expandEvent(event, from, to);

    expect(result.occurrences.map((item) => [item.recurrenceId, item.date])).toEqual([
      ["2026-10-01T19:00", "2026-10-01"],
      ["2026-11-01T19:00", "2026-11-01"],
      ["2026-12-01T19:00", "2026-10-15"],
    ]);
  });

  it("distinguishes all-day events from events with unknown times", () => {
    const [from, to] = range("2026-09-01", "2026-09-30");
    const allDay = expandEvent(
      {
        ...base,
        id: "whole-day",
        title: "Hele dagen",
        schedule: { kind: "explicit", dates: [{ kind: "all-day", date: "2026-09-10" }] },
      },
      from,
      to,
    ).occurrences[0];
    const unknown = expandEvent(
      {
        ...base,
        id: "unknown-time",
        title: "Tid kommer",
        schedule: { kind: "explicit", dates: [{ kind: "time-unknown", date: "2026-09-11" }] },
      },
      from,
      to,
    ).occurrences[0];

    expect(allDay).toMatchObject({ allDay: true, timeUnknown: false });
    expect(unknown).toMatchObject({ allDay: false, timeUnknown: true });
    expect(allDay?.startAt).toBeUndefined();
    expect(unknown?.startAt).toBeUndefined();
  });

  it("preserves overnight and multi-day intervals for ongoing events", () => {
    const event: EventRecord = {
      ...base,
      id: "ongoing-events",
      title: "Arrangementer over flere dage",
      schedule: {
        kind: "explicit",
        dates: [
          {
            kind: "timed",
            date: "2026-09-12",
            startTime: "20:00",
            endDate: "2026-09-13",
            endTime: "01:30",
          },
          { kind: "all-day", date: "2026-09-14", endDate: "2026-09-16" },
        ],
      },
    };
    const [from, to] = range("2026-09-01", "2026-09-30");
    const result = expandEvent(event, from, to);

    expect(result.occurrences[0]).toMatchObject({
      date: "2026-09-12",
      startAt: "2026-09-12T20:00:00.000+02:00",
      endAt: "2026-09-13T01:30:00.000+02:00",
    });
    expect(result.occurrences[1]).toMatchObject({
      date: "2026-09-14",
      endDate: "2026-09-16",
      allDay: true,
    });
  });

  it("does not depend on the machine's default timezone", () => {
    const event: EventRecord = {
      ...base,
      id: "timezone-independent",
      title: "Samme resultat",
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-10-18", startTime: "09:00" },
        rrule: "FREQ=WEEKLY;COUNT=3",
        rdates: [],
        exdates: [],
        overrides: [],
      },
    };
    const [from, to] = range("2026-10-18", "2026-11-02");
    const previousZone = Settings.defaultZone;
    try {
      Settings.defaultZone = "America/Los_Angeles";
      const west = expandEvent(event, from, to);
      Settings.defaultZone = "Asia/Tokyo";
      const east = expandEvent(event, from, to);
      expect(east).toEqual(west);
    } finally {
      Settings.defaultZone = previousZone;
    }
  });

  it("validates chronological all-day and timed intervals", () => {
    expect(
      eventDateSchema.safeParse({ kind: "all-day", date: "2026-09-12", endDate: "2026-09-11" }).success,
    ).toBe(false);
    expect(
      eventDateSchema.safeParse({
        kind: "timed",
        date: "2026-09-12",
        startTime: "20:00",
        endTime: "19:00",
      }).success,
    ).toBe(false);
    expect(
      eventDateSchema.safeParse({
        kind: "timed",
        date: "2026-09-12",
        startTime: "20:00",
        endDate: "2026-09-13",
        endTime: "01:00",
      }).success,
    ).toBe(true);
  });
});
