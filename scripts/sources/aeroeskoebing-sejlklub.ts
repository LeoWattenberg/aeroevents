import { createHash } from "node:crypto";

import { DateTime } from "luxon";

import { cleanText } from "./html";
import { errorMessage, fetchText } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroeskoebing-sejlklub"];
const COPENHAGEN = "Europe/Copenhagen";
const GOOGLE_CALENDAR_ORIGIN = "https://calendar.google.com";
const CALENDAR_NAME = "Ærøskøbing Sejlklub";
const MAX_EVENTS = 500;
const MAX_OCCURRENCES_PER_EVENT = 400;
const MAX_RECURRENCE_SCAN_DAYS = 400;
const MAX_EVENT_DURATION_DAYS = 366;
const ACCESS_REVIEW_REASON =
  "Aktiviteten kommer fra sejlklubbens kalender; adgang, tidspunkt og eventuel tilmelding skal kontrolleres før publicering.";

const WEEKDAYS = new Map<string, number>([
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
  ["SU", 7],
]);

interface IcsProperty {
  name: string;
  params: Map<string, string>;
  value: string;
}

interface CalendarStructure {
  properties: IcsProperty[];
  timezoneIds: string[];
  events: IcsProperty[][];
  errors: string[];
}

type TemporalKind = "date" | "date-time";
type TemporalZone = "date" | "copenhagen" | "utc";

interface ParsedTemporal {
  kind: TemporalKind;
  zone: TemporalZone;
  value: DateTime;
}

interface ParsedInterval {
  start: ParsedTemporal;
  end: ParsedTemporal;
  durationDays?: number;
  durationMilliseconds?: number;
}

interface WeeklyRule {
  weekdays: Set<number>;
  until: ParsedTemporal;
}

export interface AeroeskoebingSejlklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  rawEventCount: number;
  parsedCandidateCount: number;
  excludedBookingCount: number;
  excludedOffIslandCount: number;
  excludedPrivateCount: number;
  excludedSourceEventIds: string[];
}

interface ParsedSejlklubEvent {
  candidate?: NormalizedEventDraft;
  booking: boolean;
  offIsland: boolean;
  privateEvent: boolean;
  sourceEventId?: string;
}

function unfoldLines(ics: string): { lines: string[]; errors: string[] } {
  const errors: string[] = [];
  if (ics.includes("\0")) errors.push("iCal-feedet indeholder NUL-tegn");
  const physical = ics.replace(/^\ufeff/u, "").split(/\r\n|\n|\r/u);
  const lines: string[] = [];
  physical.forEach((line, index) => {
    if (/^[ \t]/u.test(line)) {
      if (lines.length === 0) {
        errors.push(`iCal-linje ${index + 1} fortsætter uden en foregående linje`);
        return;
      }
      lines[lines.length - 1] += line.slice(1);
      return;
    }
    if (line) lines.push(line);
  });
  return { lines, errors };
}

function delimiterIndex(value: string, delimiter: ":" | ";"): number {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (!quoted && value[index] === delimiter) return index;
  }
  return -1;
}

function splitHeader(value: string): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest) {
    const index = delimiterIndex(rest, ";");
    if (index < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  return parts;
}

function contentLine(value: string, lineNumber: number): { property?: IcsProperty; error?: string } {
  const colon = delimiterIndex(value, ":");
  if (colon <= 0) return { error: `iCal-linje ${lineNumber} mangler et egenskabsnavn eller kolon` };
  const parts = splitHeader(value.slice(0, colon));
  const name = parts.shift()?.toUpperCase();
  if (!name || !/^[A-Z0-9-]+$/u.test(name)) {
    return { error: `iCal-linje ${lineNumber} har et ugyldigt egenskabsnavn` };
  }
  const params = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals <= 0 || equals === part.length - 1) {
      return { error: `iCal-linje ${lineNumber} har en ugyldig parameter` };
    }
    const key = part.slice(0, equals).toUpperCase();
    let parameterValue = part.slice(equals + 1);
    if (!/^[A-Z0-9-]+$/u.test(key) || params.has(key)) {
      return { error: `iCal-linje ${lineNumber} har en ugyldig eller gentaget parameter` };
    }
    if (parameterValue.startsWith('"') || parameterValue.endsWith('"')) {
      if (!(parameterValue.startsWith('"') && parameterValue.endsWith('"'))) {
        return { error: `iCal-linje ${lineNumber} har ubalancerede anførselstegn` };
      }
      parameterValue = parameterValue.slice(1, -1);
    }
    params.set(key, parameterValue);
  }
  return { property: { name, params, value: value.slice(colon + 1) } };
}

function parseCalendarStructure(ics: string): CalendarStructure {
  const unfolded = unfoldLines(ics);
  const errors = [...unfolded.errors];
  const properties: IcsProperty[] = [];
  const timezoneIds: string[] = [];
  const events: IcsProperty[][] = [];
  const parsedLines = unfolded.lines.map((line, index) => {
    const parsed = contentLine(line, index + 1);
    if (parsed.error) errors.push(parsed.error);
    return parsed.property;
  });
  if (parsedLines.some((property) => property === undefined)) {
    return { properties, timezoneIds, events, errors };
  }
  const lines = parsedLines as IcsProperty[];
  if (lines[0]?.name !== "BEGIN" || lines[0].value.toUpperCase() !== "VCALENDAR") {
    errors.push("iCal-feedet begynder ikke med VCALENDAR");
    return { properties, timezoneIds, events, errors };
  }
  if (lines.at(-1)?.name !== "END" || lines.at(-1)?.value.toUpperCase() !== "VCALENDAR") {
    errors.push("iCal-feedet slutter ikke med VCALENDAR");
    return { properties, timezoneIds, events, errors };
  }

  const stack = ["VCALENDAR"];
  let currentEvent: IcsProperty[] | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const property = lines[index]!;
    if (property.name === "BEGIN") {
      const component = property.value.toUpperCase();
      if (!/^[A-Z0-9-]+$/u.test(component)) {
        errors.push(`iCal-komponent ${property.value} har et ugyldigt navn`);
        continue;
      }
      if (component === "VEVENT") {
        if (stack.length !== 1 || currentEvent) {
          errors.push("iCal-feedet indeholder en ugyldigt indlejret VEVENT");
        } else {
          currentEvent = [];
        }
      } else if (stack.length === 1 && component !== "VTIMEZONE") {
        errors.push(`iCal-feedet indeholder den ukendte topkomponent ${component}`);
      }
      stack.push(component);
      continue;
    }
    if (property.name === "END") {
      const component = property.value.toUpperCase();
      const expected = stack.at(-1);
      if (!expected || expected !== component) {
        errors.push(`iCal-komponenten ${component} afsluttes i forkert rækkefølge`);
        continue;
      }
      if (component === "VEVENT") {
        if (currentEvent) events.push(currentEvent);
        currentEvent = undefined;
      }
      stack.pop();
      if (stack.length === 0 && index !== lines.length - 1) {
        errors.push("iCal-feedet indeholder data efter VCALENDAR");
      }
      continue;
    }
    if (stack.length === 1) properties.push(property);
    if (stack.length === 2 && stack[1] === "VTIMEZONE" && property.name === "TZID") {
      timezoneIds.push(property.value);
    }
    if (currentEvent && stack.at(-1) === "VEVENT") currentEvent.push(property);
  }
  if (stack.length !== 0) errors.push("iCal-feedet indeholder en uafsluttet komponent");
  if (events.length > MAX_EVENTS) {
    errors.push(`iCal-feedet indeholder flere end ${MAX_EVENTS} begivenheder`);
  }
  return { properties, timezoneIds, events, errors };
}

function matching(properties: IcsProperty[], name: string): IcsProperty[] {
  return properties.filter((property) => property.name === name);
}

function singleProperty(
  properties: IcsProperty[],
  name: string,
  label: string,
  errors: string[],
  required: boolean,
): IcsProperty | undefined {
  const values = matching(properties, name);
  if (values.length > 1 || (required && values.length !== 1)) {
    errors.push(`${label} ${required ? "mangler eller " : ""}forekommer ${values.length} gange`);
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Decode RFC 5545 TEXT escaping after physical lines have been unfolded. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([nN,;\\])/gu, (_match, escaped: string) => {
    if (escaped === "n" || escaped === "N") return "\n";
    return escaped;
  });
}

function normalizedIcsText(value: string): string {
  return unescapeIcsText(value)
    .replace(/\u00a0/gu, " ")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
}

function exactDate(value: string): DateTime | undefined {
  if (!/^\d{8}$/u.test(value)) return undefined;
  const parsed = DateTime.fromFormat(value, "yyyyLLdd", { zone: COPENHAGEN });
  return parsed.isValid && parsed.toFormat("yyyyLLdd") === value ? parsed.startOf("day") : undefined;
}

function exactDateTime(value: string, zone: string, utcSuffix: boolean): DateTime | undefined {
  const pattern = utcSuffix ? "yyyyLLdd'T'HHmmss'Z'" : "yyyyLLdd'T'HHmmss";
  const expected = utcSuffix ? /^\d{8}T\d{6}Z$/u : /^\d{8}T\d{6}$/u;
  if (!expected.test(value)) return undefined;
  const parsed = DateTime.fromFormat(value, pattern, { zone, setZone: true });
  return parsed.isValid && parsed.toFormat(pattern) === value ? parsed : undefined;
}

function parsedTemporal(property: IcsProperty, label: string, errors: string[]): ParsedTemporal | undefined {
  const unknownParameters = [...property.params.keys()].filter(
    (key) => key !== "VALUE" && key !== "TZID",
  );
  if (unknownParameters.length > 0) {
    errors.push(`${label} bruger ukendte parametre: ${unknownParameters.join(", ")}`);
    return undefined;
  }
  const valueType = property.params.get("VALUE")?.toUpperCase();
  const timezone = property.params.get("TZID");
  if (valueType === "DATE") {
    if (timezone) {
      errors.push(`${label} kombinerer en heldagsdato med TZID`);
      return undefined;
    }
    const date = exactDate(property.value);
    if (!date) errors.push(`${label} har en ugyldig heldagsdato`);
    return date ? { kind: "date", zone: "date", value: date } : undefined;
  }
  if (valueType !== undefined && valueType !== "DATE-TIME") {
    errors.push(`${label} bruger den ukendte VALUE-type ${valueType}`);
    return undefined;
  }
  if (timezone) {
    if (timezone !== COPENHAGEN || property.value.endsWith("Z")) {
      errors.push(`${label} bruger en ikke-understøttet tidszone`);
      return undefined;
    }
    const local = exactDateTime(property.value, COPENHAGEN, false);
    if (!local) errors.push(`${label} har et ugyldigt lokalt tidspunkt`);
    if (local?.second) {
      errors.push(`${label} angiver sekunder, som den fælles eventmodel ikke kan bevare`);
      return undefined;
    }
    return local ? { kind: "date-time", zone: "copenhagen", value: local } : undefined;
  }
  const utc = exactDateTime(property.value, "UTC", true);
  if (!utc) errors.push(`${label} skal være UTC eller have TZID=Europe/Copenhagen`);
  if (utc?.second) {
    errors.push(`${label} angiver sekunder, som den fælles eventmodel ikke kan bevare`);
    return undefined;
  }
  return utc ? { kind: "date-time", zone: "utc", value: utc } : undefined;
}

function parsedInterval(
  properties: IcsProperty[],
  uidLabel: string,
  errors: string[],
): ParsedInterval | undefined {
  const startProperty = singleProperty(properties, "DTSTART", `${uidLabel} DTSTART`, errors, true);
  const endProperty = singleProperty(properties, "DTEND", `${uidLabel} DTEND`, errors, true);
  if (!startProperty || !endProperty) return undefined;
  const start = parsedTemporal(startProperty, `${uidLabel} DTSTART`, errors);
  const end = parsedTemporal(endProperty, `${uidLabel} DTEND`, errors);
  if (!start || !end) return undefined;
  if (start.kind !== end.kind) {
    errors.push(`${uidLabel} blander heldagsdato og klokkeslæt i DTSTART/DTEND`);
    return undefined;
  }
  if (end.value <= start.value) {
    errors.push(`${uidLabel} slutter før eller samtidig med starten`);
    return undefined;
  }
  if (start.kind === "date") {
    const durationDays = end.value.diff(start.value, "days").days;
    if (!Number.isSafeInteger(durationDays) || durationDays > MAX_EVENT_DURATION_DAYS) {
      errors.push(`${uidLabel} har en ugyldig heldagsvarighed`);
      return undefined;
    }
    return { start, end, durationDays };
  }
  const durationMilliseconds = end.value.toMillis() - start.value.toMillis();
  if (durationMilliseconds > MAX_EVENT_DURATION_DAYS * 86_400_000) {
    errors.push(`${uidLabel} varer mere end ${MAX_EVENT_DURATION_DAYS} dage`);
    return undefined;
  }
  return { start, end, durationMilliseconds };
}

function parsedUntil(value: string, start: ParsedTemporal, label: string, errors: string[]): ParsedTemporal | undefined {
  if (start.kind === "date") {
    const date = exactDate(value);
    if (!date) errors.push(`${label} skal være en gyldig DATE-værdi`);
    return date ? { kind: "date", zone: "date", value: date } : undefined;
  }
  const utc = exactDateTime(value, "UTC", true);
  if (!utc) errors.push(`${label} skal være et UTC-tidspunkt med Z`);
  return utc ? { kind: "date-time", zone: "utc", value: utc } : undefined;
}

function parsedWeeklyRule(
  property: IcsProperty,
  start: ParsedTemporal,
  label: string,
  errors: string[],
): WeeklyRule | undefined {
  if (property.params.size > 0) {
    errors.push(`${label} RRULE må ikke have parametre`);
    return undefined;
  }
  const parts = new Map<string, string>();
  for (const segment of property.value.split(";")) {
    const equals = segment.indexOf("=");
    const key = segment.slice(0, equals).toUpperCase();
    const value = segment.slice(equals + 1).toUpperCase();
    if (equals <= 0 || !key || !value || parts.has(key)) {
      errors.push(`${label} har en ugyldig RRULE`);
      return undefined;
    }
    parts.set(key, value);
  }
  const supported = new Set(["FREQ", "WKST", "INTERVAL", "UNTIL", "BYDAY"]);
  const unsupported = [...parts.keys()].filter((key) => !supported.has(key));
  if (
    parts.get("FREQ") !== "WEEKLY" ||
    (parts.has("WKST") && parts.get("WKST") !== "MO") ||
    (parts.has("INTERVAL") && parts.get("INTERVAL") !== "1") ||
    unsupported.length > 0
  ) {
    errors.push(`${label} bruger en ikke-understøttet gentagelsesregel`);
    return undefined;
  }
  const byDay = parts.get("BYDAY")?.split(",") ?? [];
  const weekdays = new Set(
    byDay.map((day) => WEEKDAYS.get(day)).filter((day): day is number => day !== undefined),
  );
  if (byDay.length === 0 || weekdays.size !== byDay.length || !weekdays.has(start.value.weekday)) {
    errors.push(`${label} har en ugyldig BYDAY i den ugentlige gentagelse`);
    return undefined;
  }
  const untilValue = parts.get("UNTIL");
  const until = untilValue ? parsedUntil(untilValue, start, `${label} RRULE UNTIL`, errors) : undefined;
  if (!until) {
    if (!untilValue) errors.push(`${label} mangler UNTIL i den ugentlige gentagelse`);
    return undefined;
  }
  if (until.value < start.value) {
    errors.push(`${label} RRULE slutter før DTSTART`);
    return undefined;
  }
  return { weekdays, until };
}

function temporalIdentity(value: ParsedTemporal): string {
  return value.kind === "date" ? value.value.toISODate()! : String(value.value.toMillis());
}

function parsedExdates(
  properties: IcsProperty[],
  start: ParsedTemporal,
  label: string,
  errors: string[],
): Set<string> {
  const identities = new Set<string>();
  for (const property of matching(properties, "EXDATE")) {
    const values = property.value.split(",");
    if (values.length === 0 || values.some((value) => !value)) {
      errors.push(`${label} har en tom EXDATE`);
      continue;
    }
    for (const value of values) {
      const parsed = parsedTemporal({ ...property, value }, `${label} EXDATE`, errors);
      if (!parsed) continue;
      if (parsed.kind !== start.kind) {
        errors.push(`${label} EXDATE har en anden type end DTSTART`);
        continue;
      }
      identities.add(temporalIdentity(parsed));
    }
  }
  return identities;
}

function occurrenceId(uid: string, recurrenceOrdinal: number | undefined): string {
  const digest = createHash("sha256").update(uid, "utf8").digest("hex").slice(0, 20);
  return recurrenceOrdinal === undefined
    ? `sejlklub-${digest}`
    : `sejlklub-${digest}-occurrence-${recurrenceOrdinal}`;
}

function occurrenceFromStart(
  uid: string,
  interval: ParsedInterval,
  start: ParsedTemporal,
  recurrenceOrdinal: number | undefined,
  status: EventStatus,
): ExplicitOccurrenceDraft {
  const localStart = start.value.setZone(COPENHAGEN);
  if (start.kind === "date") {
    const durationDays = interval.durationDays!;
    const inclusiveEnd = localStart.plus({ days: durationDays - 1 });
    return {
      id: occurrenceId(uid, recurrenceOrdinal),
      date: localStart.toISODate()!,
      ...(durationDays > 1 ? { endDate: inclusiveEnd.toISODate()! } : {}),
      allDay: true,
      timeUnknown: false,
      ...(status === "cancelled" ? { status } : {}),
    };
  }
  const localEnd = DateTime.fromMillis(
    start.value.toMillis() + interval.durationMilliseconds!,
    { zone: COPENHAGEN },
  );
  return {
    id: occurrenceId(uid, recurrenceOrdinal),
    date: localStart.toISODate()!,
    startTime: localStart.toFormat("HH:mm"),
    ...(localEnd.toISODate() !== localStart.toISODate() ? { endDate: localEnd.toISODate()! } : {}),
    endTime: localEnd.toFormat("HH:mm"),
    allDay: false,
    timeUnknown: false,
    ...(status === "cancelled" ? { status } : {}),
  };
}

function inCollectionWindow(value: ParsedTemporal, start: DateTime, end: DateTime): boolean {
  const localDate = value.value.setZone(COPENHAGEN).startOf("day");
  return localDate >= start && localDate <= end;
}

function weeklyOccurrenceOrdinal(
  seriesStart: ParsedTemporal,
  occurrence: ParsedTemporal,
  weekdays: ReadonlySet<number>,
): number {
  const sourceZone = seriesStart.zone === "utc" ? "UTC" : COPENHAGEN;
  const firstDay = seriesStart.value.setZone(sourceZone).startOf("day");
  const occurrenceDay = occurrence.value.setZone(sourceZone).startOf("day");
  const elapsedDays = Math.round(occurrenceDay.diff(firstDay, "days").days);
  const fullWeeks = Math.floor(elapsedDays / 7);
  const remainingDays = elapsedDays % 7;
  let ordinal = fullWeeks * weekdays.size;
  for (let offset = 0; offset <= remainingDays; offset += 1) {
    if (weekdays.has(firstDay.plus({ days: fullWeeks * 7 + offset }).weekday)) ordinal += 1;
  }
  return ordinal;
}

function recurringStarts(
  interval: ParsedInterval,
  rule: WeeklyRule,
  exdates: Set<string>,
  windowStart: DateTime,
  windowEnd: DateTime,
  label: string,
  errors: string[],
): ParsedTemporal[] {
  const start = interval.start;
  const sourceZone = start.zone === "utc" ? "UTC" : COPENHAGEN;
  const hour = start.value.hour;
  const minute = start.value.minute;
  const second = start.value.second;
  const sourceStartDay = start.value.setZone(sourceZone).startOf("day");
  const firstRelevantDay = windowStart.setZone(sourceZone).startOf("day").minus({ days: 1 });
  let cursor = sourceStartDay < firstRelevantDay ? firstRelevantDay : sourceStartDay;
  const hardEnd = windowEnd.endOf("day").setZone(sourceZone).plus({ days: 1 });
  const result: ParsedTemporal[] = [];
  let scannedDays = 0;
  while (cursor <= hardEnd) {
    scannedDays += 1;
    if (scannedDays > MAX_RECURRENCE_SCAN_DAYS) {
      errors.push(`${label} kræver scanning af mere end ${MAX_RECURRENCE_SCAN_DAYS} kalenderdage`);
      return [];
    }
    const occurrenceValue = cursor.set({ hour, minute, second, millisecond: 0 });
    const occurrence: ParsedTemporal = { kind: start.kind, zone: start.zone, value: occurrenceValue };
    if (
      occurrenceValue.hour === hour &&
      occurrenceValue.minute === minute &&
      occurrenceValue.second === second &&
      rule.weekdays.has(occurrenceValue.weekday) &&
      occurrenceValue >= start.value &&
      occurrenceValue <= rule.until.value &&
      inCollectionWindow(occurrence, windowStart, windowEnd) &&
      !exdates.has(temporalIdentity(occurrence))
    ) {
      result.push(occurrence);
      if (result.length > MAX_OCCURRENCES_PER_EVENT) {
        errors.push(`${label} giver flere end ${MAX_OCCURRENCES_PER_EVENT} forekomster`);
        return [];
      }
    }
    if (occurrenceValue > rule.until.value || cursor > hardEnd) break;
    cursor = cursor.plus({ days: 1 });
  }
  return result;
}

function eventStatus(property: IcsProperty | undefined, label: string, errors: string[]): EventStatus {
  if (!property || property.value.toUpperCase() === "CONFIRMED") return "scheduled";
  if (property.value.toUpperCase() === "CANCELLED") return "cancelled";
  errors.push(`${label} har den ikke-understøttede STATUS ${property.value}`);
  return "scheduled";
}

function sourceModifiedAt(property: IcsProperty | undefined, label: string, errors: string[]): string | undefined {
  if (!property) return undefined;
  if (property.params.size > 0) {
    errors.push(`${label} LAST-MODIFIED har ukendte parametre`);
    return undefined;
  }
  const modified = exactDateTime(property.value, "UTC", true);
  if (!modified) {
    errors.push(`${label} LAST-MODIFIED er ikke et gyldigt UTC-tidspunkt`);
    return undefined;
  }
  return modified.toUTC().toISO() ?? undefined;
}

function bookingTitle(title: string): boolean {
  const normalized = cleanText(title).toLocaleLowerCase("da-DK");
  return /^(?:(?:klubhus|klubhuset)\s+)?(?:optaget|udlejet)(?:$|[^\p{L}])/iu.test(normalized);
}

/** Conservative signals for a LOCATION that explicitly names somewhere outside Ærø. */
export function isOffIslandLocation(location: string): boolean {
  const normalized = location
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("da-DK");
  const postcodes = [...normalized.matchAll(/\b(\d{4})\b/gu)].map((match) => match[1]);
  if (postcodes.some((postcode) => !["5960", "5970", "5985"].includes(postcode!))) return true;
  return /\b(?:tyskland|germany|kappel(?:n)?|svendborg|faaborg|rudkobing|langeland|tasinge|fyn|als|flensborg|flensburg|kiel|sverige|sweden|norge|norway)\b/iu.test(
    normalized,
  );
}

function validateCalendar(structure: CalendarStructure, errors: string[]): void {
  const version = singleProperty(structure.properties, "VERSION", "VCALENDAR VERSION", errors, true);
  const name = singleProperty(structure.properties, "X-WR-CALNAME", "VCALENDAR X-WR-CALNAME", errors, true);
  const timezone = singleProperty(
    structure.properties,
    "X-WR-TIMEZONE",
    "VCALENDAR X-WR-TIMEZONE",
    errors,
    true,
  );
  if (version?.value !== "2.0") errors.push("VCALENDAR VERSION er ikke 2.0");
  if (!name || normalizedIcsText(name.value).normalize("NFC") !== CALENDAR_NAME) {
    errors.push("VCALENDAR-navnet matcher ikke Ærøskøbing Sejlklub");
  }
  if (timezone?.value !== COPENHAGEN) {
    errors.push("VCALENDAR-tidszonen er ikke Europe/Copenhagen");
  }
  if (structure.timezoneIds.length !== 1 || structure.timezoneIds[0] !== COPENHAGEN) {
    errors.push("VCALENDAR mangler én entydig Europe/Copenhagen VTIMEZONE");
  }
}

function parseEvent(
  properties: IcsProperty[],
  index: number,
  retrievedAt: string,
  windowStart: DateTime,
  windowEnd: DateTime,
  errors: string[],
): ParsedSejlklubEvent {
  const prefix = `Sejlklub-event ${index + 1}`;
  const uidProperty = singleProperty(properties, "UID", `${prefix} UID`, errors, true);
  const classProperty = singleProperty(properties, "CLASS", `${prefix} CLASS`, errors, false);
  const uid = uidProperty?.value ?? "";
  const validUid = Boolean(uid && uid.length <= 300 && !/[\s\u0000-\u001f\u007f]/u.test(uid));
  if (!validUid) errors.push(`${prefix} mangler et stabilt UID`);
  const label = uid ? `Sejlklub-event ${uid}` : prefix;
  if (classProperty?.params.size) errors.push(`${label} CLASS har ukendte parametre`);
  const classification = classProperty?.value.toUpperCase() ?? "PUBLIC";
  if (!["PUBLIC", "PRIVATE", "CONFIDENTIAL"].includes(classification)) {
    errors.push(`${label} har den ikke-understøttede CLASS ${classProperty?.value}`);
  }
  const privateEvent = classification === "PRIVATE" || classification === "CONFIDENTIAL";
  if (privateEvent) {
    return {
      booking: false,
      offIsland: false,
      privateEvent: true,
      ...(validUid ? { sourceEventId: uid } : {}),
    };
  }

  const summaryProperty = singleProperty(properties, "SUMMARY", `${prefix} SUMMARY`, errors, true);
  const descriptionProperty = singleProperty(properties, "DESCRIPTION", `${prefix} DESCRIPTION`, errors, false);
  const locationProperty = singleProperty(properties, "LOCATION", `${prefix} LOCATION`, errors, false);
  const modifiedProperty = singleProperty(properties, "LAST-MODIFIED", `${prefix} LAST-MODIFIED`, errors, false);
  const statusProperty = singleProperty(properties, "STATUS", `${prefix} STATUS`, errors, false);
  const rules = matching(properties, "RRULE");
  if (rules.length > 1) errors.push(`${prefix} har flere RRULE-egenskaber`);
  for (const unsupported of ["RDATE", "RECURRENCE-ID"]) {
    if (matching(properties, unsupported).length > 0) {
      errors.push(`${prefix} bruger den ikke-understøttede gentagelsesegenskab ${unsupported}`);
    }
  }

  const title = summaryProperty ? normalizedIcsText(summaryProperty.value) : "";
  if (!title || title.length > 240) errors.push(`${label} mangler en gyldig titel`);
  const description = descriptionProperty ? normalizedIcsText(descriptionProperty.value) : undefined;
  if (description && description.length > 10_000) errors.push(`${label} har en for lang beskrivelse`);
  const locationName = locationProperty ? normalizedIcsText(locationProperty.value) : undefined;
  if (locationName && locationName.length > 200) errors.push(`${label} har et for langt stednavn`);
  const interval = parsedInterval(properties, label, errors);
  const status = eventStatus(statusProperty, label, errors);
  const modifiedAt = sourceModifiedAt(modifiedProperty, label, errors);
  const booking = Boolean(title && bookingTitle(title));
  const offIsland = Boolean(locationName && isOffIslandLocation(locationName));
  if (!validUid || !title || !interval || rules.length > 1) {
    return {
      booking,
      offIsland,
      privateEvent: false,
      ...(validUid ? { sourceEventId: uid } : {}),
    };
  }

  const exdates = parsedExdates(properties, interval.start, label, errors);
  let starts: ParsedTemporal[];
  let recurrenceRule: WeeklyRule | undefined;
  if (rules.length === 1) {
    recurrenceRule = parsedWeeklyRule(rules[0]!, interval.start, label, errors);
    starts = recurrenceRule
      ? recurringStarts(interval, recurrenceRule, exdates, windowStart, windowEnd, label, errors)
      : [];
  } else {
    if (matching(properties, "EXDATE").length > 0) {
      errors.push(`${label} har EXDATE uden RRULE`);
    }
    starts = inCollectionWindow(interval.start, windowStart, windowEnd) ? [interval.start] : [];
  }
  if (booking || offIsland || starts.length === 0) {
    return { booking, offIsland, privateEvent: false, sourceEventId: uid };
  }

  const occurrences = starts.map((start) =>
    occurrenceFromStart(
      uid,
      interval,
      start,
      recurrenceRule
        ? weeklyOccurrenceOrdinal(interval.start, start, recurrenceRule.weekdays)
        : undefined,
      status,
    )
  );
  const accessText = `${title}\n${description ?? ""}`;
  const publicSignal = /(?:åbent\s+hus|offentlig(?:t|e)?|alle\s+er\s+velkomne)/iu.test(accessText);
  const membersSignal = /(?:kun\s+for\s+medlemmer|medlemsaktivitet)/iu.test(accessText);
  const negatedPublicSignal = /(?:ikke|ej)\s+offentlig(?:t|e)?/iu.test(accessText);
  const conflictingAccess = negatedPublicSignal || (publicSignal && membersSignal);
  const attendance = conflictingAccess
    ? "unknown"
    : publicSignal
      ? "public"
      : membersSignal
        ? "members"
        : "unknown";
  return {
    booking,
    offIsland,
    privateEvent: false,
    sourceEventId: uid,
    candidate: {
      sourceId: definition.id,
      sourceEventId: uid,
      stableId: `${definition.id}-${uid}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(locationName ? { location: { name: locationName } } : {}),
      occurrences,
      status,
      attendance,
      attendanceDetails: attendance === "public"
        ? "Kalenderen beskriver aktiviteten som åben eller offentlig."
        : attendance === "members"
          ? "Kalenderteksten angiver, at aktiviteten kun er for medlemmer."
          : "Kalenderen oplyser ikke entydigt, om aktiviteten er offentlig eller kun for medlemmer.",
      publication: "review",
      reviewReasons: [ACCESS_REVIEW_REASON],
      provenance: {
        sourceId: definition.id,
        externalId: uid,
        sourceUrl: definition.url,
        retrievedAt,
        ...(modifiedAt ? { sourceModifiedAt: modifiedAt } : {}),
      },
    },
  };
}

export function parseAeroeskoebingSejlklubCalendar(
  ics: string,
  retrievedAt: string,
  now: Date,
): AeroeskoebingSejlklubParseResult {
  const structure = parseCalendarStructure(ics);
  const errors = [...structure.errors];
  const warnings: string[] = [];
  validateCalendar(structure, errors);
  const today = DateTime.fromJSDate(now).setZone(COPENHAGEN).startOf("day");
  const rangeEnd = today.plus({ months: 12 }).endOf("day");
  if (!today.isValid) errors.push("Indsamlingstidspunktet er ugyldigt");
  if (errors.length > 0) {
    return {
      candidates: [],
      warnings: [],
      errors: [...new Set(errors)],
      rawEventCount: structure.events.length,
      parsedCandidateCount: 0,
      excludedBookingCount: 0,
      excludedOffIslandCount: 0,
      excludedPrivateCount: 0,
      excludedSourceEventIds: [],
    };
  }

  const candidates: NormalizedEventDraft[] = [];
  const seenUids = new Set<string>();
  const excludedSourceEventIds = new Set<string>();
  let excludedBookingCount = 0;
  let excludedOffIslandCount = 0;
  let excludedPrivateCount = 0;
  structure.events.forEach((properties, index) => {
    const parsed = parseEvent(properties, index, retrievedAt, today, rangeEnd, errors);
    if (parsed.booking) excludedBookingCount += 1;
    if (parsed.offIsland) excludedOffIslandCount += 1;
    if (parsed.privateEvent) excludedPrivateCount += 1;
    if (!parsed.candidate) {
      if (parsed.sourceEventId) excludedSourceEventIds.add(parsed.sourceEventId);
      return;
    }
    if (seenUids.has(parsed.candidate.sourceEventId)) {
      errors.push(`Sejlklubbens kalender indeholder UID ${parsed.candidate.sourceEventId} flere gange`);
      return;
    }
    seenUids.add(parsed.candidate.sourceEventId);
    candidates.push(parsed.candidate);
  });

  // Duplicate UIDs must also be detected when one copy is historical or filtered.
  const allUids = structure.events
    .map((properties) => matching(properties, "UID")[0]?.value)
    .filter((value): value is string => Boolean(value));
  if (new Set(allUids).size !== allUids.length) {
    errors.push("Sejlklubbens kalender indeholder samme UID flere gange");
  }
  if (excludedBookingCount > 0) {
    warnings.push(`${excludedBookingCount} klubhusbookinger blev udeladt`);
  }
  if (excludedOffIslandCount > 0) {
    warnings.push(
      `${excludedOffIslandCount} ${excludedOffIslandCount === 1 ? "aktivitet" : "aktiviteter"} med et eksplicit sted uden for Ærø blev udeladt`,
    );
  }
  if (excludedPrivateCount > 0) {
    warnings.push(`${excludedPrivateCount} private eller fortrolige kalenderposter blev udeladt`);
  }
  candidates.sort((left, right) => {
    const occurrenceOrder = left.occurrences[0]!.date.localeCompare(right.occurrences[0]!.date);
    return occurrenceOrder || left.sourceEventId.localeCompare(right.sourceEventId);
  });
  const uniqueErrors = [...new Set(errors)];
  return {
    candidates: uniqueErrors.length > 0 ? [] : candidates,
    warnings,
    errors: uniqueErrors,
    rawEventCount: structure.events.length,
    parsedCandidateCount: candidates.length,
    excludedBookingCount,
    excludedOffIslandCount,
    excludedPrivateCount,
    excludedSourceEventIds: [...excludedSourceEventIds].sort(),
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const ics = await fetchText(context, definition.url, {
      expectedOrigin: GOOGLE_CALENDAR_ORIGIN,
      headers: { accept: "text/calendar, text/plain;q=0.9" },
    });
    const parsed = parseAeroeskoebingSejlklubCalendar(ics, retrievedAt, context.now);
    const errors = [...parsed.errors];
    if (parsed.rawEventCount === 0) {
      errors.push("Ærøskøbing Sejlklubs iCal-feed indeholder ingen begivenheder");
    }
    if (parsed.candidates.length === 0 && errors.length === 0) {
      errors.push("Ærøskøbing Sejlklubs iCal-feed indeholder ingen fremtidige klubaktiviteter i indsamlingsvinduet");
    }
    if (errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: [...new Set(errors)],
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.parsedCandidateCount,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds: parsed.excludedSourceEventIds,
      errors: [],
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const aeroeskoebingSejlklubSource: SourceAdapter = { definition, collect };
