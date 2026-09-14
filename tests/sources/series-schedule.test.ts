import { describe, expect, it } from "vitest";

import {
  boundedMonthlyNthWeekdaySchedule,
  boundedWeeklySchedule,
} from "../../scripts/sources/series-schedule";
import type { ExplicitOccurrenceDraft } from "../../scripts/sources/types";

function occurrence(date: string, startTime = "18:30", endTime = "19:30"): ExplicitOccurrenceDraft {
  return {
    id: `booking-${date}`,
    date,
    startTime,
    endTime,
    allDay: false,
    timeUnknown: false,
  };
}

describe("source series schedule compaction", () => {
  it("preserves a bounded weekly series and its missing source dates", () => {
    expect(boundedWeeklySchedule([
      occurrence("2026-09-28"),
      occurrence("2026-10-05"),
      occurrence("2026-10-19"),
    ])).toEqual({
      kind: "recurring",
      dtstart: { kind: "timed", date: "2026-09-28", startTime: "18:30" },
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T183000",
      rdates: [],
      exdates: ["2026-10-12T18:30"],
      overrides: [],
      durationMinutes: 60,
    });
  });

  it("uses a two-week interval only when every observation has that phase", () => {
    expect(boundedWeeklySchedule([
      occurrence("2026-09-18", "16:00", "18:00"),
      occurrence("2026-10-02", "16:00", "18:00"),
      occurrence("2026-10-16", "16:00", "18:00"),
    ])?.rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20261016T160000");
  });

  it("does not infer a rule across changing times or weekdays", () => {
    expect(boundedWeeklySchedule([
      occurrence("2026-09-28"),
      occurrence("2026-10-06"),
    ])).toBeUndefined();
    expect(boundedWeeklySchedule([
      occurrence("2026-09-28"),
      occurrence("2026-10-05", "19:00", "20:00"),
    ])).toBeUndefined();
  });

  it("uses an override rather than losing an exceptional duration", () => {
    expect(boundedWeeklySchedule([
      occurrence("2026-09-17", "15:00", "16:30"),
      occurrence("2026-09-24", "15:00", "17:00"),
      occurrence("2026-10-01", "15:00", "17:00"),
    ])).toMatchObject({
      durationMinutes: 120,
      overrides: [{
        recurrenceId: "2026-09-17T15:00",
        replacement: {
          kind: "timed",
          date: "2026-09-17",
          startTime: "15:00",
          endTime: "16:30",
        },
      }],
    });
  });

  it("preserves monthly omissions, additions, and exceptional durations", () => {
    expect(boundedMonthlyNthWeekdaySchedule([
      occurrence("2026-10-04", "13:30", "16:30"),
      {
        ...occurrence("2026-10-25", "13:30", "16:30"),
        endDate: "2026-11-01",
      },
      occurrence("2026-12-06", "13:30", "16:30"),
      occurrence("2027-01-03", "13:30", "16:30"),
    ], 7, 1)).toEqual({
      kind: "recurring",
      dtstart: { kind: "timed", date: "2026-10-04", startTime: "13:30" },
      rrule: "FREQ=MONTHLY;BYDAY=SU;BYSETPOS=1;UNTIL=20270103T133000",
      rdates: [{ kind: "timed", date: "2026-10-25", startTime: "13:30" }],
      exdates: ["2026-11-01T13:30"],
      overrides: [{
        recurrenceId: "2026-10-25T13:30",
        replacement: {
          kind: "timed",
          date: "2026-10-25",
          startTime: "13:30",
          endDate: "2026-11-01",
          endTime: "16:30",
        },
      }],
      durationMinutes: 180,
    });
  });
});
