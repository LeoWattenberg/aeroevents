import { DateTime } from "luxon";

import type { ExplicitOccurrenceDraft, RecurringScheduleDraft } from "./types";

const COPENHAGEN = "Europe/Copenhagen";
const WEEKDAYS = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function compactDateTime(date: string, time: string): string {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function modalDuration(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return values.reduce<number | undefined>((selected, value) => {
    if (selected === undefined) return value;
    return (counts.get(value) ?? 0) > (counts.get(selected) ?? 0) ? value : selected;
  }, undefined);
}

function timedDurationMinutes(occurrence: ExplicitOccurrenceDraft): number | undefined {
  if (
    occurrence.allDay ||
    occurrence.timeUnknown ||
    !occurrence.startTime ||
    !occurrence.endTime ||
    occurrence.status ||
    occurrence.location
  ) {
    return undefined;
  }
  const start = DateTime.fromISO(`${occurrence.date}T${occurrence.startTime}`, {
    zone: COPENHAGEN,
  });
  const end = DateTime.fromISO(
    `${occurrence.endDate ?? occurrence.date}T${occurrence.endTime}`,
    { zone: COPENHAGEN },
  );
  if (!start.isValid || !end.isValid || end <= start) return undefined;
  const minutes = end.diff(start, "minutes").minutes;
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined;
}

function isNthWeekdayOfMonth(date: DateTime, weekday: number, ordinal: number): boolean {
  if (date.weekday !== weekday) return false;
  if (ordinal > 0) return Math.ceil(date.day / 7) === ordinal;
  const daysInMonth = date.daysInMonth;
  return daysInMonth !== undefined && -Math.ceil((daysInMonth - date.day + 1) / 7) === ordinal;
}

function nthWeekdayOfMonth(month: DateTime, weekday: number, ordinal: number): DateTime | undefined {
  const edge = ordinal > 0 ? month.startOf("month") : month.endOf("month").startOf("day");
  const distance = ordinal > 0
    ? (weekday - edge.weekday + 7) % 7
    : (edge.weekday - weekday + 7) % 7;
  const candidate = ordinal > 0
    ? edge.plus({ days: distance + (ordinal - 1) * 7 })
    : edge.minus({ days: distance + (-ordinal - 1) * 7 });
  return candidate.month === month.month ? candidate : undefined;
}

/**
 * Compact an explicitly identified source series without inventing any
 * occurrence. The bounded rule and EXDATEs expand to exactly the observations
 * supplied by the source.
 */
export function boundedWeeklySchedule(
  values: ExplicitOccurrenceDraft[],
): RecurringScheduleDraft | undefined {
  if (values.length < 2) return undefined;
  const occurrences = [...values].sort((left, right) =>
    `${left.date}T${left.startTime ?? ""}`.localeCompare(`${right.date}T${right.startTime ?? ""}`),
  );
  const first = occurrences[0]!;
  const firstDate = DateTime.fromISO(first.date, { zone: COPENHAGEN }).startOf("day");
  if (!firstDate.isValid || !first.startTime) return undefined;

  const observedDates = new Set<string>();
  const weekOffsets: number[] = [];
  const durations: number[] = [];
  for (const occurrence of occurrences) {
    const date = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN }).startOf("day");
    const duration = timedDurationMinutes(occurrence);
    const elapsedDays = date.diff(firstDate, "days").days;
    if (
      !date.isValid ||
      occurrence.startTime !== first.startTime ||
      date.weekday !== firstDate.weekday ||
      duration === undefined ||
      !Number.isSafeInteger(elapsedDays) ||
      elapsedDays < 0 ||
      elapsedDays % 7 !== 0 ||
      observedDates.has(occurrence.date)
    ) {
      return undefined;
    }
    observedDates.add(occurrence.date);
    weekOffsets.push(elapsedDays / 7);
    durations.push(duration);
  }

  const durationMinutes = modalDuration(durations);
  if (durationMinutes === undefined) return undefined;

  const gaps = weekOffsets.slice(1).map((offset, index) => offset - weekOffsets[index]!);
  const interval = gaps.reduce(greatestCommonDivisor);
  if (!Number.isSafeInteger(interval) || interval < 1) return undefined;
  const last = occurrences.at(-1)!;
  const lastDate = DateTime.fromISO(last.date, { zone: COPENHAGEN }).startOf("day");
  const exdates: string[] = [];
  for (let cursor = firstDate; cursor <= lastDate; cursor = cursor.plus({ weeks: interval })) {
    const date = cursor.toISODate()!;
    if (!observedDates.has(date)) exdates.push(`${date}T${first.startTime}`);
  }
  const weekday = WEEKDAYS[firstDate.weekday];
  if (!weekday) return undefined;
  const overrides = occurrences.flatMap((occurrence, index) => {
    if (durations[index] === durationMinutes) return [];
    return [{
      recurrenceId: `${occurrence.date}T${occurrence.startTime!}`,
      replacement: {
        kind: "timed" as const,
        date: occurrence.date,
        startTime: occurrence.startTime!,
        ...(occurrence.endDate ? { endDate: occurrence.endDate } : {}),
        ...(occurrence.endTime ? { endTime: occurrence.endTime } : {}),
      },
    }];
  });

  return {
    kind: "recurring",
    dtstart: { kind: "timed", date: first.date, startTime: first.startTime },
    rrule:
      `FREQ=WEEKLY;${interval > 1 ? `INTERVAL=${interval};` : ""}` +
      `BYDAY=${weekday};UNTIL=${compactDateTime(last.date, first.startTime)}`,
    rdates: [],
    exdates,
    overrides,
    durationMinutes,
  };
}

/**
 * Preserve a source-declared monthly weekday rule while retaining every
 * irregular observation as an RFC 5545 exclusion, addition, or override.
 */
export function boundedMonthlyNthWeekdaySchedule(
  values: ExplicitOccurrenceDraft[],
  weekday: number,
  ordinal: number,
): RecurringScheduleDraft | undefined {
  if (
    values.length < 2 ||
    !Number.isSafeInteger(weekday) ||
    weekday < 1 ||
    weekday > 7 ||
    !Number.isSafeInteger(ordinal) ||
    ordinal === 0 ||
    ordinal < -5 ||
    ordinal > 5
  ) {
    return undefined;
  }

  const occurrences = [...values].sort((left, right) =>
    `${left.date}T${left.startTime ?? ""}`.localeCompare(`${right.date}T${right.startTime ?? ""}`),
  );
  const parsed = occurrences.map((occurrence) => ({
    occurrence,
    date: DateTime.fromISO(occurrence.date, { zone: COPENHAGEN }).startOf("day"),
    durationMinutes: timedDurationMinutes(occurrence),
  }));
  const firstStartTime = occurrences[0]?.startTime;
  const identities = new Set<string>();
  if (
    !firstStartTime ||
    parsed.some(({ occurrence, date, durationMinutes }) => {
      const identity = `${occurrence.date}T${occurrence.startTime ?? ""}`;
      if (
        !date.isValid ||
        occurrence.startTime !== firstStartTime ||
        durationMinutes === undefined ||
        identities.has(identity)
      ) {
        return true;
      }
      identities.add(identity);
      return false;
    })
  ) {
    return undefined;
  }

  const regular = parsed.filter(({ date }) => isNthWeekdayOfMonth(date, weekday, ordinal));
  if (regular.length < 2) return undefined;
  const first = regular[0]!;
  const last = regular.at(-1)!;
  const durationMinutes = first.durationMinutes!;
  const observedRegularDates = new Set(regular.map(({ occurrence }) => occurrence.date));
  const exdates: string[] = [];
  for (
    let month = first.date.startOf("month");
    month <= last.date.startOf("month");
    month = month.plus({ months: 1 })
  ) {
    const expected = nthWeekdayOfMonth(month, weekday, ordinal);
    if (!expected) continue;
    const date = expected.toISODate()!;
    if (!observedRegularDates.has(date)) exdates.push(`${date}T${firstStartTime}`);
  }

  const rdates = parsed
    .filter(({ date }) => !isNthWeekdayOfMonth(date, weekday, ordinal))
    .map(({ occurrence }) => ({
      kind: "timed" as const,
      date: occurrence.date,
      startTime: occurrence.startTime!,
    }));
  const overrides = parsed
    .filter(({ durationMinutes: duration }) => duration !== durationMinutes)
    .map(({ occurrence }) => ({
      recurrenceId: `${occurrence.date}T${occurrence.startTime!}`,
      replacement: {
        kind: "timed" as const,
        date: occurrence.date,
        startTime: occurrence.startTime!,
        ...(occurrence.endDate ? { endDate: occurrence.endDate } : {}),
        ...(occurrence.endTime ? { endTime: occurrence.endTime } : {}),
      },
    }));
  const ruleWeekday = WEEKDAYS[weekday];
  if (!ruleWeekday) return undefined;

  return {
    kind: "recurring",
    dtstart: {
      kind: "timed",
      date: first.occurrence.date,
      startTime: firstStartTime,
    },
    rrule:
      `FREQ=MONTHLY;BYDAY=${ruleWeekday};BYSETPOS=${ordinal};` +
      `UNTIL=${compactDateTime(last.occurrence.date, firstStartTime)}`,
    rdates,
    exdates,
    overrides,
    durationMinutes,
  };
}
