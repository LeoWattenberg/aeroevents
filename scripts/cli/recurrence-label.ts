import { DateTime } from "luxon";

type UnknownRecord = Record<string, unknown>;

const WEEKDAYS: Record<string, string> = {
  MO: "mandag",
  TU: "tirsdag",
  WE: "onsdag",
  TH: "torsdag",
  FR: "fredag",
  SA: "lørdag",
  SU: "søndag",
};

const MONTHS = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
] as const;

const ORDINALS: Record<number, string> = {
  1: "første",
  2: "anden",
  3: "tredje",
  4: "fjerde",
  5: "femte",
  [-1]: "sidste",
  [-2]: "næstsidste",
};

const SUPPORTED_RULE_PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYSETPOS",
  "BYMONTH",
  "COUNT",
  "UNTIL",
]);

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(values: string[]): string {
  if (values.length < 2) return values[0] || "";
  if (values.length === 2) return `${values[0]} og ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} og ${values.at(-1)}`;
}

function monthLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const rawMonths = value.split(",");
  if (
    !rawMonths.length ||
    rawMonths.some((month) => !/^(?:[1-9]|1[0-2])$/.test(month)) ||
    new Set(rawMonths).size !== rawMonths.length
  ) {
    return undefined;
  }
  const months = rawMonths.map(Number).sort((left, right) => left - right);

  const ranges: string[] = [];
  for (let index = 0; index < months.length;) {
    const first = months[index]!;
    let last = first;
    while (months[index + 1] === last + 1) {
      index += 1;
      last = months[index]!;
    }
    ranges.push(first === last ? MONTHS[first - 1]! : `${MONTHS[first - 1]}–${MONTHS[last - 1]}`);
    index += 1;
  }
  return list(ranges);
}

function ruleParts(value: string): Map<string, string> | undefined {
  const result = new Map<string, string>();
  const raw = value.replace(/^RRULE:/i, "");
  if (!raw || /[\r\n]/.test(raw)) return undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) return undefined;
    const key = part.slice(0, separator).toUpperCase();
    const partValue = part.slice(separator + 1).toUpperCase();
    if (!/^[A-Z]+$/.test(key) || result.has(key)) return undefined;
    result.set(key, partValue);
  }
  return result;
}

function weekdayParts(value: string | undefined): Array<{ weekday: string; ordinal?: number }> | undefined {
  if (!value) return [];
  const result: Array<{ weekday: string; ordinal?: number }> = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const match = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(part);
    if (!match?.[2] || seen.has(part)) return undefined;
    const ordinal = match[1] ? Number(match[1]) : undefined;
    if (ordinal === 0) return undefined;
    seen.add(part);
    result.push({ weekday: match[2], ...(ordinal !== undefined ? { ordinal } : {}) });
  }
  return result;
}

function clockLabel(schedule: UnknownRecord): { valid: boolean; label?: string } {
  const start = record(schedule.dtstart);
  if (!start || !["timed", "all-day", "time-unknown"].includes(String(start.kind))) {
    return { valid: false };
  }
  if (schedule.durationDays !== undefined) return { valid: false };
  if (start.kind !== "timed") {
    return schedule.durationMinutes === undefined ? { valid: true } : { valid: false };
  }
  const startTime = text(start.startTime);
  if (!startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) return { valid: false };
  // Recurring expansion intentionally uses durationMinutes. An end stored on
  // DTSTART would not be applied to generated occurrences, so do not imply it is.
  if (start.endTime !== undefined || start.endDate !== undefined) return { valid: false };
  if (schedule.durationMinutes === undefined) return { valid: true, label: `kl. ${startTime}` };
  const duration = schedule.durationMinutes;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0) {
    return { valid: false };
  }
  const parsed = DateTime.fromFormat(startTime, "HH:mm");
  if (!parsed.isValid) return { valid: false };
  const finish = parsed.plus({ minutes: duration });
  const dayOffset = Math.floor((parsed.hour * 60 + parsed.minute + duration) / (24 * 60));
  const suffix = dayOffset === 0
    ? ""
    : dayOffset === 1
      ? " næste dag"
      : ` ${dayOffset} dage senere`;
  return { valid: true, label: `kl. ${startTime}–${finish.toFormat("HH:mm")}${suffix}` };
}

function untilLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsedDate = DateTime.fromISO(date, { zone: "utc" });
  if (!parsedDate.isValid || parsedDate.toISODate() !== date) return undefined;
  if (!match[4]) return `til og med ${date}`;
  const time = `${match[4]}:${match[5]}:${match[6]}`;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return undefined;
  return match[7] ? `til ${date} ${time}Z` : `til ${date} kl. ${time.slice(0, 5)}`;
}

function startDate(schedule: UnknownRecord): string | undefined {
  const value = text(record(schedule.dtstart)?.date);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { zone: "utc" });
  return parsed.isValid && parsed.toISODate() === value ? value : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function signedInteger(value: string | undefined): number | undefined {
  if (!value || !/^[+-]?[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function changeLabel(schedule: UnknownRecord): { valid: boolean; label?: string } {
  const configurations = [
    {
      key: "exdates",
      singular: "undtagelse",
      plural: "undtagelser",
      valid: (value: unknown) => Boolean(text(value)),
    },
    {
      key: "rdates",
      singular: "ekstra dato",
      plural: "ekstra datoer",
      valid: (value: unknown) => Boolean(record(value)),
    },
    {
      key: "overrides",
      singular: "ændret forekomst",
      plural: "ændrede forekomster",
      valid: (value: unknown) => Boolean(record(value)),
    },
  ] as const;
  const labels: string[] = [];
  for (const configuration of configurations) {
    const value = schedule[configuration.key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(configuration.valid)) return { valid: false };
    if (value.length) {
      labels.push(
        `${value.length} ${value.length === 1 ? configuration.singular : configuration.plural}`,
      );
    }
  }
  return labels.length ? { valid: true, label: `med ${list(labels)}` } : { valid: true };
}

/** Render the common RFC 5545 rules used by researched club schedules. */
export function recurrenceLabel(scheduleValue: unknown): string | undefined {
  const schedule = record(scheduleValue);
  if (schedule?.kind !== "recurring") return undefined;
  const rawRule = text(schedule.rrule);
  if (!rawRule) return undefined;
  const parts = ruleParts(rawRule);
  if (!parts) return undefined;
  if ([...parts.keys()].some((key) => !SUPPORTED_RULE_PARTS.has(key))) return undefined;

  const frequency = parts.get("FREQ");
  const interval = parts.has("INTERVAL") ? positiveInteger(parts.get("INTERVAL")) : 1;
  if (!interval) return undefined;
  const weekdays = weekdayParts(parts.get("BYDAY"));
  if (!weekdays) return undefined;
  let cadence: string | undefined;

  if (frequency === "WEEKLY" && weekdays.length) {
    if (parts.has("BYSETPOS") || weekdays.some((item) => item.ordinal !== undefined)) return undefined;
    const names = weekdays.map((item) => WEEKDAYS[item.weekday]!);
    cadence = interval === 1
      ? `hver ${list(names)}`
      : interval === 2 && names.length === 1
        ? `hver anden ${names[0]}`
        : `${interval === 2 ? "hver anden uge" : `hver ${interval}. uge`} på ${list(names)}`;
  } else if (frequency === "MONTHLY" && weekdays.length === 1) {
    const day = weekdays[0]!;
    if (day.ordinal !== undefined && parts.has("BYSETPOS")) return undefined;
    const ordinal = day.ordinal ?? signedInteger(parts.get("BYSETPOS"));
    if (!ordinal || !ORDINALS[ordinal]) return undefined;
    const occurrence = `${ORDINALS[ordinal]} ${WEEKDAYS[day.weekday]}`;
    cadence = interval === 1
      ? `hver ${occurrence} i måneden`
      : `${interval === 2 ? "hver anden måned" : `hver ${interval}. måned`} på månedens ${occurrence}`;
  }
  if (!cadence) return undefined;

  const monthRule = parts.get("BYMONTH");
  const months = monthLabel(monthRule);
  if (monthRule && !months) return undefined;
  const clock = clockLabel(schedule);
  if (!clock.valid) return undefined;
  const anchor = startDate(schedule);
  if (!anchor) return undefined;
  const untilRule = parts.get("UNTIL");
  const until = untilLabel(untilRule);
  if (untilRule && !until) return undefined;
  const countRule = parts.get("COUNT");
  const count = positiveInteger(countRule);
  if ((countRule && !count) || (count && until)) return undefined;
  const changes = changeLabel(schedule);
  if (!changes.valid) return undefined;
  return [
    cadence,
    ...(months ? [`i ${months}`] : []),
    `fra ${anchor}`,
    ...(clock.label ? [clock.label] : []),
    ...(until ? [until] : []),
    ...(count ? [`${count} gange`] : []),
    ...(changes.label ? [changes.label] : []),
  ].join(" ");
}
