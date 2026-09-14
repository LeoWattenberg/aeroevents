import { describe, expect, it } from "vitest";
import {
  calendarFilename,
  calendarResponse,
  categoryCalendarPath,
  eventCalendarPath,
  foldContentLine,
  ICALENDAR_MEDIA_TYPE,
  occurrenceUid,
  renderICalendar,
} from "../src/lib/ical";
import { eventSchema, occurrenceSchema, type EventRecord, type Occurrence } from "../src/lib/schema";

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  eventSchema.parse({
    id: "koncert-paa-havnen",
    title: "Koncert, kaffe; hygge \\ og Ærø",
    description:
      "Første linje\nAnden linje med en meget lang beskrivelse, så UTF-8-indholdet bliver foldet korrekt uden at dele et dansk tegn.",
    organizerId: "musikforeningen",
    categoryIds: ["musik-kultur"],
    location: {
      name: "Det gamle værft",
      address: "Havnevej 1",
      postalCode: "5960",
      city: "Marstal",
    },
    attendance: { kind: "public" },
    status: "scheduled",
    publication: "published",
    schedule: {
      kind: "explicit",
      dates: [{ kind: "timed", date: "2027-03-28", startTime: "09:00", endTime: "11:00" }],
    },
    source: {
      sourceId: "manual",
      url: "https://source.example/events/42",
      modifiedAt: "2026-09-13T10:15:30+02:00",
    },
    ...overrides,
  });

const occurrence = (overrides: Partial<Occurrence> = {}): Occurrence =>
  occurrenceSchema.parse({
    id: "koncert-paa-havnen--2027-03-28T0900",
    eventId: "koncert-paa-havnen",
    recurrenceId: "2027-03-28T09:00",
    date: "2027-03-28",
    startAt: "2027-03-28T09:00:00+02:00",
    endAt: "2027-03-28T11:00:00+02:00",
    allDay: false,
    timeUnknown: false,
    status: "scheduled",
    ...overrides,
  });

const unfold = (calendar: string): string => calendar.replace(/\r\n[ \t]/g, "");

describe("renderICalendar", () => {
  it("renders interoperable UTC times, stable identities and escaped Danish text", () => {
    const calendar = renderICalendar({
      name: "Det sker på Ærø – Musik",
      description: "Koncerter, teater og kultur",
      events: [event()],
      occurrences: [occurrence()],
      categories: [{ id: "musik-kultur", name: "Musik, kultur", color: "#a44432" }],
      organizers: [{ id: "musikforeningen", name: "Musikforeningen Ærø", email: "hej@example.dk" }],
      generatedAt: "2026-09-14T08:00:00Z",
      eventUrl: () => "https://calendar.example.dk/aeroevents/begivenheder/koncert-paa-havnen/",
      sourceUrl: "https://calendar.example.dk/aeroevents/kalender/kategorier/musik-kultur.ics",
    });
    const value = unfold(calendar);

    expect(calendar.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(calendar.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(calendar.replaceAll("\r\n", "")).not.toContain("\n");
    expect(value).toContain("PRODID:-//Aeroevents//Det sker på Ærø//DA\r\n");
    expect(value).toContain("DTSTART:20270328T070000Z\r\n");
    expect(value).toContain("DTEND:20270328T090000Z\r\n");
    expect(value).toContain("DTSTAMP:20260914T080000Z\r\n");
    expect(value).toContain("LAST-MODIFIED:20260913T081530Z\r\n");
    expect(value).toContain("SUMMARY;LANGUAGE=da:Koncert\\, kaffe\\; hygge \\\\ og Ærø\r\n");
    expect(value).toContain("DESCRIPTION;LANGUAGE=da:Første linje\\nAnden linje");
    expect(value).toContain("LOCATION;LANGUAGE=da:Det gamle værft\\, Havnevej 1\\, 5960 Marstal\r\n");
    expect(value).toContain("CATEGORIES;LANGUAGE=da:Musik\\, kultur\r\n");
    expect(value).toContain("ORGANIZER:mailto:hej@example.dk\r\n");
    expect(value).toContain("URL:https://calendar.example.dk/aeroevents/begivenheder/koncert-paa-havnen/\r\n");
    expect(value).toContain("STATUS:CONFIRMED\r\n");
    expect(value).toMatch(/UID:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\r\n/);

    const encoder = new TextEncoder();
    for (const line of calendar.split("\r\n").slice(0, -1)) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(75);
    }
  });

  it("uses exclusive DTEND dates for inclusive all-day ranges", () => {
    const allDay = occurrence({
      id: "koncert-paa-havnen--festival",
      recurrenceId: "festival",
      date: "2026-09-14",
      startAt: undefined,
      endAt: undefined,
      endDate: "2026-09-16",
      allDay: true,
    });
    const calendar = unfold(
      renderICalendar({
        name: "Festival",
        events: [event()],
        occurrences: [allDay],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar).toContain("DTSTART;VALUE=DATE:20260914\r\n");
    expect(calendar).toContain("DTEND;VALUE=DATE:20260917\r\n");
    expect(calendar).not.toContain("X-AEROEVENTS-TIME-UNKNOWN");
  });

  it("marks dates with unknown times without inventing a clock time", () => {
    const unknownTime = occurrence({
      id: "koncert-paa-havnen--ukendt",
      recurrenceId: "ukendt",
      date: "2026-11-01",
      startAt: undefined,
      endAt: undefined,
      allDay: false,
      timeUnknown: true,
    });
    const calendar = unfold(
      renderICalendar({
        name: "Ukendt tid",
        events: [event({ description: "" })],
        occurrences: [unknownTime],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar).toContain("DTSTART;VALUE=DATE:20261101\r\n");
    expect(calendar).toContain("DTEND;VALUE=DATE:20261102\r\n");
    expect(calendar).toContain("X-AEROEVENTS-TIME-UNKNOWN:TRUE\r\n");
    expect(calendar).toContain("DESCRIPTION;LANGUAGE=da:Tidspunktet er ikke oplyst.\r\n");
  });

  it("maps cancellations and postponements to RFC 5545 statuses", () => {
    const cancelled = occurrence({ id: "cancelled", recurrenceId: "cancelled", status: "cancelled" });
    const postponed = occurrence({ id: "postponed", recurrenceId: "postponed", status: "postponed" });
    const calendar = unfold(
      renderICalendar({
        name: "Statusser",
        events: [event()],
        occurrences: [cancelled, postponed],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar.match(/STATUS:CANCELLED/g)).toHaveLength(1);
    expect(calendar.match(/STATUS:TENTATIVE/g)).toHaveLength(1);
    expect(calendar).toContain("X-AEROEVENTS-STATUS:POSTPONED\r\n");
  });

  it("omits a non-positive timed end instead of emitting an invalid DTEND", () => {
    const calendar = unfold(
      renderICalendar({
        name: "Kort arrangement",
        events: [event()],
        occurrences: [occurrence({ endAt: "2027-03-28T09:00:00+02:00" })],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar).toContain("DTSTART:20270328T070000Z\r\n");
    expect(calendar).not.toContain("DTEND:");
  });

  it("keeps an empty subscription valid without adding a visible placeholder event", () => {
    const calendar = unfold(
      renderICalendar({
        name: "Tom kategori",
        events: [],
        occurrences: [],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar).toContain("X-AEROEVENTS-EMPTY:TRUE\r\n");
    expect(calendar).toContain("BEGIN:VTIMEZONE\r\n");
    expect(calendar).toContain("TZID:Etc/UTC\r\n");
    expect(calendar).not.toContain("BEGIN:VEVENT");
  });

  it("omits orphan occurrences and keeps an occurrence UID stable when its date moves", () => {
    const id = "koncert-paa-havnen--2026-11-01T1900";
    const moved = occurrence({ id, date: "2026-11-03", startAt: "2026-11-03T20:00:00+01:00" });
    const orphan = occurrence({ id: "orphan", eventId: "missing", recurrenceId: "orphan" });
    const calendar = unfold(
      renderICalendar({
        name: "Flyttet",
        events: [event()],
        occurrences: [moved, orphan],
        generatedAt: "2026-09-14T08:00:00Z",
      }),
    );

    expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(calendar).toContain(`UID:${occurrenceUid(id)}\r\n`);
    expect(occurrenceUid(id)).toBe(occurrenceUid(id));
  });
});

describe("calendar export helpers", () => {
  it("folds by bytes rather than JavaScript string length", () => {
    const folded = foldContentLine(`DESCRIPTION:${"Æ".repeat(40)}`);
    const lines = folded.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.startsWith(" ")).toBe(true);
    for (const line of lines) expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  });

  it("publishes stable, base-path-neutral route contracts", () => {
    expect(eventCalendarPath("event-42")).toBe("/kalender/begivenheder/event-42.ics");
    expect(categoryCalendarPath("musik-kultur")).toBe("/kalender/kategorier/musik-kultur.ics");
  });

  it("uses safe calendar filenames and response headers", async () => {
    expect(calendarFilename("musik/kultur" )).toBe("musik-kultur.ics");
    const response = calendarResponse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "musik-kultur");
    expect(response.headers.get("content-type")).toBe(ICALENDAR_MEDIA_TYPE);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="musik-kultur.ics"');
    expect(await response.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  });
});
