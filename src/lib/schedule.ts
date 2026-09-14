import { DateTime } from "luxon";
import * as RRuleModule from "rrule";
import type { RRule, RRuleSet } from "rrule";
import type { EventDate, EventRecord, Occurrence } from "./schema";

// rrule 2.x publishes ESM types but a CommonJS runtime entry. Normalise both
// Node's and Vite's interop shapes in one place.
const RRuleRuntime = ((RRuleModule as unknown as { default?: typeof RRuleModule }).default ?? RRuleModule) as typeof RRuleModule;
const { datetime, rrulestr, RRuleSet: RuntimeRRuleSet } = RRuleRuntime;

export const CALENDAR_ZONE = "Europe/Copenhagen";

export interface ExpansionResult {
  occurrences: Occurrence[];
  warnings: string[];
}

function parseDateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Ugyldig dato: ${value}`);
  return [year, month, day];
}

function parseTimeParts(value: string | undefined): [number, number] {
  if (!value) return [0, 0];
  const [hour, minute] = value.split(":").map(Number);
  if (hour === undefined || minute === undefined) throw new Error(`Ugyldigt tidspunkt: ${value}`);
  return [hour, minute];
}

function fakeUtc(value: EventDate): Date {
  const [year, month, day] = parseDateParts(value.date);
  const [hour, minute] = value.kind === "timed" ? parseTimeParts(value.startTime) : [0, 0];
  return datetime(year, month, day, hour, minute);
}

function fakeUtcFromIdentity(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Ugyldig recurrenceId/exdate: ${value}`);
  return datetime(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0));
}

export function wallIdentity(value: EventDate): string {
  if (value.id) return value.id;
  return value.kind === "timed" ? `${value.date}T${value.startTime}` : value.date;
}

function localDateTime(dateValue: string, timeValue = "00:00"): { value?: DateTime; warning?: string } {
  const [year, month, day] = parseDateParts(dateValue);
  const [hour, minute] = parseTimeParts(timeValue);
  const local = DateTime.fromObject({ year, month, day, hour, minute }, { zone: CALENDAR_ZONE });

  if (
    !local.isValid ||
    local.year !== year ||
    local.month !== month ||
    local.day !== day ||
    local.hour !== hour ||
    local.minute !== minute
  ) {
    return { warning: `Tidspunktet ${dateValue} ${timeValue} findes ikke i ${CALENDAR_ZONE}` };
  }

  const possible = local.getPossibleOffsets();
  const chosen = possible.length > 1 ? [...possible].sort((a, b) => a.toMillis() - b.toMillis())[0]! : local;
  return { value: chosen };
}

function occurrenceId(eventId: string, recurrenceId: string): string {
  return `${eventId}--${recurrenceId.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

function materialize(
  event: EventRecord,
  value: EventDate,
  recurrenceId: string,
  status = event.status,
  location = event.location,
  recurringDuration?: { minutes?: number; days?: number },
): { occurrence?: Occurrence; warning?: string } {
  const common = {
    id: occurrenceId(event.id, recurrenceId),
    eventId: event.id,
    recurrenceId,
    date: value.date,
    allDay: value.kind === "all-day",
    timeUnknown: value.kind === "time-unknown",
    status,
    ...(location ? { location } : {}),
  } satisfies Omit<Occurrence, "startAt" | "endAt" | "endDate">;

  if (value.kind === "time-unknown") return { occurrence: common };
  if (value.kind === "all-day") {
    const days = recurringDuration?.days;
    const endDate = value.endDate ?? (days ? DateTime.fromISO(value.date).plus({ days }).toISODate() ?? undefined : undefined);
    return { occurrence: { ...common, ...(endDate ? { endDate } : {}) } };
  }

  const start = localDateTime(value.date, value.startTime);
  if (!start.value) return { warning: `${event.id}: ${start.warning}` };

  let end: DateTime | undefined;
  if (value.endTime) {
    const parsedEnd = localDateTime(value.endDate ?? value.date, value.endTime);
    if (!parsedEnd.value) return { warning: `${event.id}: ${parsedEnd.warning}` };
    end = parsedEnd.value;
  } else if (recurringDuration?.minutes) {
    end = start.value.plus({ minutes: recurringDuration.minutes });
  }

  return {
    occurrence: {
      ...common,
      startAt: start.value.toISO()!,
      ...(end ? { endAt: end.toISO()! } : {}),
    },
  };
}

function eventDateFromFake(template: EventDate, value: Date): EventDate {
  const dateValue = [value.getUTCFullYear(), String(value.getUTCMonth() + 1).padStart(2, "0"), String(value.getUTCDate()).padStart(2, "0")].join("-");
  if (template.kind === "timed") {
    const startTime = `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
    return { kind: "timed", date: dateValue, startTime };
  }
  return { kind: template.kind, date: dateValue };
}

function inDateRange(value: EventDate, start: DateTime, end: DateTime): boolean {
  const dateValue = DateTime.fromISO(value.date, { zone: CALENDAR_ZONE });
  return dateValue >= start.startOf("day") && dateValue <= end.endOf("day");
}

export function expandEvent(event: EventRecord, rangeStart: DateTime, rangeEnd: DateTime): ExpansionResult {
  const occurrences: Occurrence[] = [];
  const warnings: string[] = [];

  if (event.schedule.kind === "explicit") {
    for (const dateValue of event.schedule.dates) {
      if (!inDateRange(dateValue, rangeStart, rangeEnd)) continue;
      const result = materialize(
        event,
        dateValue,
        wallIdentity(dateValue),
        dateValue.status ?? event.status,
        dateValue.location ?? event.location,
      );
      if (result.occurrence) occurrences.push(result.occurrence);
      if (result.warning) warnings.push(result.warning);
    }
    return { occurrences, warnings };
  }

  const schedule = event.schedule;
  try {
    const duration = {
      ...(schedule.durationMinutes !== undefined ? { minutes: schedule.durationMinutes } : {}),
      ...(schedule.durationDays !== undefined ? { days: schedule.durationDays } : {}),
    };
    const rule = rrulestr(schedule.rrule.startsWith("RRULE:") ? schedule.rrule : `RRULE:${schedule.rrule}`, {
      dtstart: fakeUtc(schedule.dtstart),
    }) as RRule;
    const parsed = new RuntimeRRuleSet() as RRuleSet;
    parsed.rrule(rule);
    for (const extra of schedule.rdates) parsed.rdate(fakeUtc(extra));
    for (const excluded of schedule.exdates) parsed.exdate(fakeUtcFromIdentity(excluded));

    const fakeStart = datetime(rangeStart.year, rangeStart.month, rangeStart.day);
    const fakeEnd = datetime(rangeEnd.year, rangeEnd.month, rangeEnd.day, 23, 59, 59);
    const overrides = new Map(schedule.overrides.map((override) => [override.recurrenceId, override]));

    for (const candidate of parsed.between(fakeStart, fakeEnd, true)) {
      const original = eventDateFromFake(schedule.dtstart, candidate);
      const recurrenceId = wallIdentity(original);
      const override = overrides.get(recurrenceId);
      const value = override?.replacement ?? original;
      if (override?.replacement && !inDateRange(value, rangeStart, rangeEnd)) {
        overrides.delete(recurrenceId);
        continue;
      }
      const result = materialize(
        event,
        value,
        recurrenceId,
        override?.status ?? event.status,
        override?.location ?? event.location,
        duration,
      );
      if (result.occurrence) occurrences.push(result.occurrence);
      if (result.warning) warnings.push(result.warning);
      overrides.delete(recurrenceId);
    }

    for (const [recurrenceId, override] of overrides) {
      if (!override.replacement || !inDateRange(override.replacement, rangeStart, rangeEnd)) continue;
      const result = materialize(
        event,
        override.replacement,
        recurrenceId,
        override.status ?? event.status,
        override.location ?? event.location,
        duration,
      );
      if (result.occurrence) occurrences.push(result.occurrence);
      if (result.warning) warnings.push(result.warning);
    }
  } catch (error) {
    warnings.push(`${event.id}: Kunne ikke udvide gentagelse: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { occurrences, warnings };
}

export function expandEvents(
  events: EventRecord[],
  rangeStart: DateTime,
  rangeEnd: DateTime,
): ExpansionResult {
  const results = events.map((event) => expandEvent(event, rangeStart, rangeEnd));
  return {
    occurrences: results.flatMap((result) => result.occurrences).sort((a, b) => {
      const aKey = a.startAt ?? `${a.date}T00:00:00`;
      const bKey = b.startAt ?? `${b.date}T00:00:00`;
      return aKey.localeCompare(bKey) || a.id.localeCompare(b.id);
    }),
    warnings: results.flatMap((result) => result.warnings),
  };
}
