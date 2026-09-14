import { DateTime } from "luxon";

import type { ExplicitOccurrenceDraft } from "./types";

const COPENHAGEN = "Europe/Copenhagen";

function occurrence(id: string, date: DateTime, startTime: string, endTime: string): ExplicitOccurrenceDraft {
  return {
    id: `${id}-${date.toISODate()}`,
    date: date.toISODate()!,
    startTime,
    endTime,
    allDay: false,
    timeUnknown: false,
  };
}

/** Materialise a stated rule for a bounded review horizon; the source is re-read on every run. */
export function weeklyOccurrences(
  id: string,
  weekday: number,
  startTime: string,
  endTime: string,
  now: Date,
): ExplicitOccurrenceDraft[] {
  const start = DateTime.fromJSDate(now, { zone: COPENHAGEN }).startOf("day");
  const end = start.plus({ months: 12 }).endOf("day");
  let current = start.plus({ days: (weekday - start.weekday + 7) % 7 });
  const result: ExplicitOccurrenceDraft[] = [];
  while (current <= end) {
    result.push(occurrence(id, current, startTime, endTime));
    current = current.plus({ weeks: 1 });
  }
  return result;
}

export function monthlyNthWeekdayOccurrences(
  id: string,
  weekday: number,
  ordinal: number,
  startTime: string,
  endTime: string,
  now: Date,
): ExplicitOccurrenceDraft[] {
  const start = DateTime.fromJSDate(now, { zone: COPENHAGEN }).startOf("day");
  const end = start.plus({ months: 12 }).endOf("day");
  const result: ExplicitOccurrenceDraft[] = [];
  for (let offset = 0; offset <= 12; offset += 1) {
    const first = start.startOf("month").plus({ months: offset });
    const current = first.plus({ days: (weekday - first.weekday + 7) % 7 + (ordinal - 1) * 7 });
    if (current >= start && current <= end) {
      result.push(occurrence(id, current, startTime, endTime));
    }
  }
  return result;
}

export function normalizedTime(hour: string, minute = "00"): string | undefined {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) return undefined;
  if (!Number.isInteger(parsedMinute) || parsedMinute < 0 || parsedMinute > 59) return undefined;
  return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
}
