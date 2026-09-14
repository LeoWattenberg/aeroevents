import { createHash } from "node:crypto";
import type { Category, EventRecord, Occurrence, Organizer } from "./schema";

const CRLF = "\r\n";
const MAX_CONTENT_LINE_OCTETS = 75;
const UUID_NAMESPACE = "4f34a59c-35d3-4f73-9f96-4fd997b938c6";

export const ICALENDAR_MEDIA_TYPE = "text/calendar; charset=utf-8";
export const CALENDAR_REFRESH_INTERVAL = "PT6H";

export interface ICalendarOptions {
  name: string;
  description?: string;
  events: readonly EventRecord[];
  occurrences: readonly Occurrence[];
  categories?: readonly Category[];
  organizers?: readonly Organizer[];
  generatedAt: string;
  eventUrl?: (event: EventRecord) => string;
  sourceUrl?: string;
}

/**
 * Stable public paths used by the event download and category subscription UI.
 * Apply the configured Astro base path at the call site with `sitePath()`.
 */
export function eventCalendarPath(eventId: string): string {
  return `/kalender/begivenheder/${encodeURIComponent(eventId)}.ics`;
}

export function categoryCalendarPath(categoryId: string): string {
  return `/kalender/kategorier/${encodeURIComponent(categoryId)}.ics`;
}

function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function safeUri(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

/** Fold a content line by UTF-8 octets, never in the middle of a code point. */
export function foldContentLine(line: string): string {
  const encoder = new TextEncoder();
  const sections: string[] = [];
  let section = "";
  let octets = 0;
  let limit = MAX_CONTENT_LINE_OCTETS;

  for (const character of line) {
    const characterOctets = encoder.encode(character).byteLength;
    if (section && octets + characterOctets > limit) {
      sections.push(section);
      section = character;
      octets = characterOctets;
      // A folded continuation starts with one whitespace octet.
      limit = MAX_CONTENT_LINE_OCTETS - 1;
    } else {
      section += character;
      octets += characterOctets;
    }
  }
  sections.push(section);

  return sections.map((value, index) => (index === 0 ? value : ` ${value}`)).join(CRLF);
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Ugyldig kalenderdato: ${value}`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function utcDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Ugyldigt kalendertidspunkt: ${value}`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function uuidBytes(value: string): Uint8Array {
  return Uint8Array.from(value.replaceAll("-", "").match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/** RFC 4122 UUIDv5, used so an occurrence keeps its UID across feed rebuilds. */
export function occurrenceUid(occurrenceId: string): string {
  const digest = createHash("sha1")
    .update(uuidBytes(UUID_NAMESPACE))
    .update(`aeroevents:occurrence:${occurrenceId}`, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hexadecimal = digest.toString("hex");
  const uuid = [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
  return uuid;
}

function occurrenceStatus(occurrence: Occurrence): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (occurrence.status === "cancelled") return "CANCELLED";
  if (occurrence.status === "postponed") return "TENTATIVE";
  return "CONFIRMED";
}

function locationText(event: EventRecord, occurrence: Occurrence): string | undefined {
  const location = occurrence.location ?? event.location;
  if (!location) return undefined;
  const locality = [location.postalCode, location.city].filter(Boolean).join(" ");
  return [location.name, location.address, locality].filter(Boolean).join(", ");
}

function descriptionText(event: EventRecord, occurrence: Occurrence): string | undefined {
  const details: string[] = [];
  if (occurrence.timeUnknown || (!occurrence.allDay && !occurrence.startAt)) {
    details.push("Tidspunktet er ikke oplyst.");
  }
  if (occurrence.status === "cancelled") details.push("Arrangementet er aflyst.");
  if (occurrence.status === "postponed") {
    details.push("Arrangementet er udsat. Kontrollér kilden for et nyt tidspunkt.");
  }
  if (event.description) details.push(event.description);
  if (event.price) details.push(`Pris: ${event.price}`);
  if (event.booking?.soldOut) details.push("Arrangementet er udsolgt.");
  if (event.booking?.required) details.push("Tilmelding eller billet er nødvendig.");
  if (event.booking?.details) details.push(event.booking.details);
  if (event.booking?.url) details.push(`Tilmelding: ${event.booking.url}`);
  if (event.attendance.details) details.push(event.attendance.details);
  return details.length ? details.join("\n\n") : undefined;
}

function eventLines(
  event: EventRecord,
  occurrence: Occurrence,
  options: ICalendarOptions,
  categoryById: ReadonlyMap<string, Category>,
  organizerById: ReadonlyMap<string, Organizer>,
): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${occurrenceUid(occurrence.id)}`,
    `DTSTAMP:${utcDateTime(options.generatedAt)}`,
  ];

  if (event.source.modifiedAt) lines.push(`LAST-MODIFIED:${utcDateTime(event.source.modifiedAt)}`);

  if (occurrence.allDay || occurrence.timeUnknown || !occurrence.startAt) {
    const inclusiveEnd = occurrence.endDate ?? occurrence.date;
    lines.push(`DTSTART;VALUE=DATE:${compactDate(occurrence.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(nextDate(inclusiveEnd))}`);
    if (occurrence.timeUnknown || (!occurrence.allDay && !occurrence.startAt)) {
      lines.push("X-AEROEVENTS-TIME-UNKNOWN:TRUE");
    }
  } else {
    lines.push(`DTSTART:${utcDateTime(occurrence.startAt)}`);
    // RFC 5545 requires a timed DTEND to be later than DTSTART. Treat an
    // upstream zero/negative duration as an event without an explicit end.
    if (occurrence.endAt && Date.parse(occurrence.endAt) > Date.parse(occurrence.startAt)) {
      lines.push(`DTEND:${utcDateTime(occurrence.endAt)}`);
    }
  }

  lines.push(`SUMMARY;LANGUAGE=da:${escapeText(event.title)}`);
  const description = descriptionText(event, occurrence);
  if (description) lines.push(`DESCRIPTION;LANGUAGE=da:${escapeText(description)}`);

  const location = locationText(event, occurrence);
  if (location) lines.push(`LOCATION;LANGUAGE=da:${escapeText(location)}`);

  const organizer = event.organizerName ?? organizerById.get(event.organizerId)?.name;
  if (organizer) lines.push(`CONTACT;LANGUAGE=da:${escapeText(organizer)}`);
  const organizerEmail = organizerById.get(event.organizerId)?.email;
  if (organizerEmail) lines.push(`ORGANIZER:mailto:${safeUri(organizerEmail)}`);

  const categoryNames = event.categoryIds.map((id) => categoryById.get(id)?.name ?? id);
  if (categoryNames.length) {
    lines.push(`CATEGORIES;LANGUAGE=da:${categoryNames.map(escapeText).join(",")}`);
  }

  const pageUrl = options.eventUrl?.(event);
  if (pageUrl) lines.push(`URL:${safeUri(pageUrl)}`);
  lines.push(`STATUS:${occurrenceStatus(occurrence)}`);
  if (occurrence.status === "postponed") lines.push("X-AEROEVENTS-STATUS:POSTPONED");
  lines.push("CLASS:PUBLIC", "END:VEVENT");
  return lines;
}

export function renderICalendar(options: ICalendarOptions): string {
  const eventById = new Map(options.events.map((event) => [event.id, event]));
  const categoryById = new Map((options.categories ?? []).map((category) => [category.id, category]));
  const organizerById = new Map((options.organizers ?? []).map((organizer) => [organizer.id, organizer]));
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Aeroevents//Det sker på Ærø//DA",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `NAME;LANGUAGE=da:${escapeText(options.name)}`,
    `X-WR-CALNAME:${escapeText(options.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${CALENDAR_REFRESH_INTERVAL}`,
    `X-PUBLISHED-TTL:${CALENDAR_REFRESH_INTERVAL}`,
  ];

  if (options.description) {
    lines.push(`DESCRIPTION;LANGUAGE=da:${escapeText(options.description)}`);
    lines.push(`X-WR-CALDESC:${escapeText(options.description)}`);
  }
  if (options.sourceUrl) lines.push(`SOURCE;VALUE=URI:${safeUri(options.sourceUrl)}`);

  const occurrences = [...options.occurrences].sort((left, right) => {
    const leftStart = left.startAt ?? left.date;
    const rightStart = right.startAt ?? right.date;
    return leftStart.localeCompare(rightStart) || left.id.localeCompare(right.id);
  });
  for (const occurrence of occurrences) {
    const event = eventById.get(occurrence.eventId);
    if (event) lines.push(...eventLines(event, occurrence, options, categoryById, organizerById));
  }
  if (!lines.includes("BEGIN:VEVENT")) {
    // An iCalendar object must contain at least one calendar component. An
    // inert UTC VTIMEZONE keeps a category subscription valid while the feed
    // has no current events, without creating a visible placeholder event.
    lines.push(
      "X-AEROEVENTS-EMPTY:TRUE",
      "BEGIN:VTIMEZONE",
      "TZID:Etc/UTC",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "TZNAME:UTC",
      "END:STANDARD",
      "END:VTIMEZONE",
    );
  }
  lines.push("END:VCALENDAR");

  return `${lines.map(foldContentLine).join(CRLF)}${CRLF}`;
}

export function calendarFilename(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return `${safeId || "kalender"}.ics`;
}

export function calendarResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": ICALENDAR_MEDIA_TYPE,
      "Content-Disposition": `inline; filename="${calendarFilename(filename)}"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
