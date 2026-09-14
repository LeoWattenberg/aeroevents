import type { RecurringScheduleDraft } from "./types";

const WEEKDAYS = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const JANUARY_2000_WEEKDAY_DATES = ["", "2000-01-03", "2000-01-04", "2000-01-05", "2000-01-06", "2000-01-07", "2000-01-08", "2000-01-09"] as const;

function durationMinutes(startTime: string, endTime: string): number {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return endHour! * 60 + endMinute! - (startHour! * 60 + startMinute!);
}

function checkedWeekday(weekday: number): { date: string; code: string } {
  const date = JANUARY_2000_WEEKDAY_DATES[weekday];
  const code = WEEKDAYS[weekday];
  if (!date || !code) throw new Error(`Ugyldig ugedag: ${weekday}`);
  return { date, code };
}

function nthWeekdayAnchor(weekday: number, ordinal: number): string {
  for (let month = 0; month < 12; month += 1) {
    const first = new Date(Date.UTC(2000, month, 1));
    const firstWeekday = first.getUTCDay() || 7;
    const day = 1 + (weekday - firstWeekday + 7) % 7 + (ordinal - 1) * 7;
    const candidate = new Date(Date.UTC(2000, month, day));
    if (candidate.getUTCMonth() === month) return candidate.toISOString().slice(0, 10);
  }
  throw new Error(`Kunne ikke danne anker for ugedag ${weekday}, nummer ${ordinal}`);
}

/** Build a stable wall-clock rule when the source states no series start date. */
export function weeklySchedule(
  weekday: number,
  startTime: string,
  endTime: string,
): RecurringScheduleDraft {
  const anchor = checkedWeekday(weekday);
  return {
    kind: "recurring",
    dtstart: { kind: "timed", date: anchor.date, startTime },
    startDateUnknown: true,
    rrule: `FREQ=WEEKLY;BYDAY=${anchor.code}`,
    rdates: [],
    exdates: [],
    overrides: [],
    durationMinutes: durationMinutes(startTime, endTime),
  };
}

export function monthlyNthWeekdaySchedule(
  weekday: number,
  ordinal: number,
  startTime: string,
  endTime: string,
): RecurringScheduleDraft {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 5) {
    throw new Error(`Ugyldigt ugedagsnummer i måneden: ${ordinal}`);
  }
  const anchor = checkedWeekday(weekday);
  return {
    kind: "recurring",
    dtstart: { kind: "timed", date: nthWeekdayAnchor(weekday, ordinal), startTime },
    startDateUnknown: true,
    rrule: `FREQ=MONTHLY;BYDAY=${anchor.code};BYSETPOS=${ordinal}`,
    rdates: [],
    exdates: [],
    overrides: [],
    durationMinutes: durationMinutes(startTime, endTime),
  };
}

export function normalizedTime(hour: string, minute = "00"): string | undefined {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) return undefined;
  if (!Number.isInteger(parsedMinute) || parsedMinute < 0 || parsedMinute > 59) return undefined;
  return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
}
