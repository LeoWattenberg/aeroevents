import type { CalendarEventView, EventStatus, OccurrenceView } from "./calendar-types";

export const COPENHAGEN_TIMEZONE = "Europe/Copenhagen";

const longDate = new Intl.DateTimeFormat("da-DK", {
  timeZone: COPENHAGEN_TIMEZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const shortDate = new Intl.DateTimeFormat("da-DK", {
  timeZone: COPENHAGEN_TIMEZONE,
  day: "numeric",
  month: "short",
});

const time = new Intl.DateTimeFormat("da-DK", {
  timeZone: COPENHAGEN_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dateOnlyInstant(value: string): Date {
  return new Date(`${value.slice(0, 10)}T12:00:00Z`);
}

export function dateLabel(date: string): string {
  return longDate.format(dateOnlyInstant(date));
}

export function shortDateLabel(date: string): string {
  return shortDate.format(dateOnlyInstant(date));
}

export function capitalize(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase("da-DK") + value.slice(1) : value;
}

export function occurrenceTimeLabel(occurrence: OccurrenceView): string {
  if (occurrence.allDay) {
    return occurrence.endDate && occurrence.endDate > occurrence.date
      ? `Hele dagen · til og med ${shortDateLabel(occurrence.endDate)}`
      : "Hele dagen";
  }
  if (occurrence.timeUnknown || !occurrence.start.includes("T")) return "Tidspunkt ikke oplyst";

  const start = new Date(occurrence.start);
  const startLabel = time.format(start).replace(":", ".");
  if (!occurrence.end) return `kl. ${startLabel}`;

  const end = new Date(occurrence.end);
  const endDate = localDateKey(end);
  if (endDate === occurrence.date) {
    return `kl. ${startLabel}–${time.format(end).replace(":", ".")}`;
  }

  return `fra ${startLabel} til ${shortDateLabel(endDate)} kl. ${time.format(end).replace(":", ".")}`;
}

export function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COPENHAGEN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function currentLocalDate(): string {
  return localDateKey(new Date());
}

export function calendarToday(generatedAt?: string): string {
  if (generatedAt) {
    const generated = new Date(generatedAt);
    if (!Number.isNaN(generated.getTime())) return localDateKey(generated);
  }
  return currentLocalDate();
}

export function occurrenceLastDate(occurrence: OccurrenceView): string {
  if (occurrence.endDate) return occurrence.endDate;
  if (occurrence.end) {
    const end = new Date(occurrence.end);
    if (!Number.isNaN(end.getTime())) return localDateKey(end);
  }
  return occurrence.date;
}

export function statusLabel(status: EventStatus | undefined): string | undefined {
  if (status === "cancelled") return "Aflyst";
  if (status === "postponed") return "Udsat";
  if (status === "sold-out") return "Udsolgt";
  return undefined;
}

export function attendanceLabel(attendance: CalendarEventView["attendance"]): string | undefined {
  if (attendance === "members") return "Kun for medlemmer";
  if (attendance === "registration") return "Tilmelding nødvendig";
  return undefined;
}
