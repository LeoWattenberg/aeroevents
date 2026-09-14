import { describe, expect, it } from "vitest";

import {
  aeroeskoebingSejlklubSource,
  isOffIslandLocation,
  parseAeroeskoebingSejlklubCalendar,
  unescapeIcsText,
} from "../../scripts/sources/aeroeskoebing-sejlklub";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const SOURCE_URL =
  "https://calendar.google.com/calendar/ical/9db3eee6cb77ad0a86cb2c024117df053701c9e5e4898f548914f560650e3df9%40group.calendar.google.com/public/basic.ics";

describe("Ærøskøbing Sejlklub source", () => {
  it("unfolds and unescapes the calendar while expanding bounded weekly occurrences", async () => {
    const parsed = parseAeroeskoebingSejlklubCalendar(
      await fixture("aeroeskoebing-sejlklub.ics"),
      NOW.toISOString(),
      NOW,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rawEventCount).toBe(10);
    expect(parsed.excludedBookingCount).toBe(4);
    expect(parsed.excludedOffIslandCount).toBe(1);
    expect(parsed.excludedPrivateCount).toBe(0);
    expect(parsed.excludedSourceEventIds).toEqual([
      "booking-four@google.com",
      "booking-one@google.com",
      "booking-three@google.com",
      "booking-two@google.com",
      "historical@google.com",
      "off-island@google.com",
    ]);
    expect(parsed.candidates).toHaveLength(4);
    expect(parsed.candidates[0]).toMatchObject({
      sourceEventId: "series-kapsejlads@google.com",
      stableId: "aeroeskoebing-sejlklub-series-kapsejlads@google.com",
      title: "Kapsejlads",
      description: "Første linje\nAnden linje med komma, semikolon; og bagsla\\.",
      attendance: "unknown",
      publication: "review",
      provenance: { sourceModifiedAt: "2026-09-12T08:15:00.000Z" },
    });
    expect(parsed.candidates[0]!.occurrences.map((occurrence) => occurrence.date)).toEqual([
      "2026-09-16",
      "2026-09-30",
      "2026-10-07",
    ]);
    expect(parsed.candidates[0]!.occurrences[0]).toMatchObject({
      startTime: "18:00",
      endTime: "19:00",
      allDay: false,
    });
    expect(parsed.candidates[0]!.occurrences.every((occurrence) =>
      /^sejlklub-[a-f0-9]{20}-occurrence-\d+$/u.test(occurrence.id)
    )).toBe(true);
  });

  it("normalizes exclusive DATE ends, UTC instants, cancellation, location, and modified time", async () => {
    const parsed = parseAeroeskoebingSejlklubCalendar(
      await fixture("aeroeskoebing-sejlklub.ics"),
      NOW.toISOString(),
      NOW,
    );
    const haulout = parsed.candidates.find((candidate) => candidate.sourceEventId === "first-haulout@google.com");
    const cancelled = parsed.candidates.find((candidate) => candidate.sourceEventId === "cancelled-meeting@google.com");
    const openHouse = parsed.candidates.find((candidate) => candidate.sourceEventId === "open-house@google.com");

    expect(haulout).toMatchObject({
      occurrences: [{ date: "2026-10-02", endDate: "2026-10-03", allDay: true }],
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      occurrences: [{ date: "2027-01-16", status: "cancelled" }],
    });
    expect(openHouse).toMatchObject({
      title: "ÅBENT HUS - prøv optimistjollesejlads",
      attendance: "public",
      location: { name: "Marstal Sejlklub, Sejlmagervej 7, 5960 Marstal, Danmark" },
      occurrences: [{ date: "2027-05-09", startTime: "11:00", endTime: "13:00" }],
      provenance: { sourceModifiedAt: "2026-09-10T11:22:33.000Z" },
    });
  });

  it("filters every booking marker and only explicit off-island locations", async () => {
    const parsed = parseAeroeskoebingSejlklubCalendar(
      await fixture("aeroeskoebing-sejlklub.ics"),
      NOW.toISOString(),
      NOW,
    );
    const serialized = JSON.stringify(parsed.candidates);

    expect(serialized).not.toMatch(/klubhus|klubhuset|optaget|udlejet/iu);
    expect(serialized).not.toContain("Kappeln");
    expect(isOffIslandLocation("Kappeln, Tyskland")).toBe(true);
    expect(isOffIslandLocation("Havnen, 5700 Svendborg")).toBe(true);
    expect(isOffIslandLocation("Marstal Sejlklub, 5960 Marstal")).toBe(false);

    const legitimateClubhouseActivity = parseAeroeskoebingSejlklubCalendar(
      (await fixture("aeroeskoebing-sejlklub.ics")).replace(
        "SUMMARY:Klubhus udlejet",
        "SUMMARY:Arbejdsdag i klubhuset",
      ),
      NOW.toISOString(),
      NOW,
    );
    expect(legitimateClubhouseActivity.candidates.some(
      (candidate) => candidate.sourceEventId === "booking-one@google.com",
    )).toBe(true);
  });

  it("keeps UID-based identity when a non-recurring date moves", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const original = parseAeroeskoebingSejlklubCalendar(ics, NOW.toISOString(), NOW)
      .candidates.find((candidate) => candidate.sourceEventId === "first-haulout@google.com")!;
    const moved = parseAeroeskoebingSejlklubCalendar(
      ics.replace("DTSTART;VALUE=DATE:20261002\nDTEND;VALUE=DATE:20261004", "DTSTART;VALUE=DATE:20261009\nDTEND;VALUE=DATE:20261011"),
      NOW.toISOString(),
      NOW,
    ).candidates.find((candidate) => candidate.sourceEventId === "first-haulout@google.com")!;

    expect(moved.sourceEventId).toBe(original.sourceEventId);
    expect(moved.stableId).toBe(original.stableId);
    expect(moved.occurrences[0]!.id).toBe(original.occurrences[0]!.id);
    expect(moved.occurrences[0]!.date).toBe("2026-10-09");
  });

  it("keeps ordinal occurrence identities when a recurring series time moves", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const original = parseAeroeskoebingSejlklubCalendar(ics, NOW.toISOString(), NOW)
      .candidates.find((candidate) => candidate.sourceEventId === "series-kapsejlads@google.com")!;
    const moved = parseAeroeskoebingSejlklubCalendar(
      ics
        .replace("DTSTART;TZID=Europe/Copenhagen:20260902T180000", "DTSTART;TZID=Europe/Copenhagen:20260902T190000")
        .replace("DTEND;TZID=Europe/Copenhagen:20260902T190000", "DTEND;TZID=Europe/Copenhagen:20260902T200000")
        .replace("EXDATE;TZID=Europe/Copenhagen:20260923T180000", "EXDATE;TZID=Europe/Copenhagen:20260923T190000"),
      NOW.toISOString(),
      NOW,
    ).candidates.find((candidate) => candidate.sourceEventId === "series-kapsejlads@google.com")!;

    expect(moved.occurrences.map((occurrence) => occurrence.id)).toEqual(
      original.occurrences.map((occurrence) => occurrence.id),
    );
    expect(moved.occurrences[0]!.startTime).toBe("19:00");
  });

  it("rejects unsupported recurrence and duplicate UIDs atomically", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const unsupported = await aeroeskoebingSejlklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: {
          status: 200,
          body: ics.replace("FREQ=WEEKLY", "FREQ=MONTHLY"),
          contentType: "text/calendar; charset=utf-8",
        },
      }),
    });
    const duplicate = parseAeroeskoebingSejlklubCalendar(
      ics.replace("UID:first-haulout@google.com", "UID:series-kapsejlads@google.com"),
      NOW.toISOString(),
      NOW,
    );

    expect(unsupported.status).toBe("partial");
    expect(unsupported.candidates).toEqual([]);
    expect(unsupported.errors.join(" ")).toContain("ikke-understøttet gentagelsesregel");
    expect(duplicate.candidates).toEqual([]);
    expect(duplicate.errors.join(" ")).toContain("samme UID");
  });

  it("validates calendar identity and rejects unsupported timezones", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const wrongName = parseAeroeskoebingSejlklubCalendar(
      ics.replace("X-WR-CALNAME:Ærøskøbing Sejlklub", "X-WR-CALNAME:En anden kalender"),
      NOW.toISOString(),
      NOW,
    );
    const wrongTimezone = parseAeroeskoebingSejlklubCalendar(
      ics.replace(
        "DTSTART;TZID=Europe/Copenhagen:20260902T180000",
        "DTSTART;TZID=Europe/Berlin:20260902T180000",
      ),
      NOW.toISOString(),
      NOW,
    );

    expect(wrongName.errors.join(" ")).toContain("navnet matcher ikke");
    expect(wrongTimezone.errors.join(" ")).toContain("ikke-understøttet tidszone");
    expect(wrongTimezone.candidates).toEqual([]);
    expect(unescapeIcsText("Linje 1\\nLinje 2\\, x\\; y\\\\z")).toBe("Linje 1\nLinje 2, x; y\\z");
  });

  it("excludes private metadata and rejects sub-minute source times atomically", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const privateEvent = parseAeroeskoebingSejlklubCalendar(
      ics
        .replace("UID:first-haulout@google.com", "CLASS:PRIVATE\nUID:first-haulout@google.com")
        .replace("SUMMARY:1. bådoptagning", "SUMMARY:Hemmelig privat aktivitet"),
      NOW.toISOString(),
      NOW,
    );
    const seconds = await aeroeskoebingSejlklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: {
          status: 200,
          body: ics.replace("DTSTART:20270509T090000Z", "DTSTART:20270509T090030Z"),
          contentType: "text/calendar",
        },
      }),
    });

    expect(privateEvent.excludedPrivateCount).toBe(1);
    expect(privateEvent.excludedSourceEventIds).toContain("first-haulout@google.com");
    expect(JSON.stringify(privateEvent.candidates)).not.toContain("Hemmelig privat aktivitet");
    expect(seconds.status).toBe("partial");
    expect(seconds.candidates).toEqual([]);
    expect(seconds.errors.join(" ")).toContain("angiver sekunder");
  });

  it("does not infer public access from negated or conflicting wording", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const negated = parseAeroeskoebingSejlklubCalendar(
      ics.replace("DESCRIPTION:Prøv en tur på vandet.", "DESCRIPTION:Ikke offentligt."),
      NOW.toISOString(),
      NOW,
    ).candidates.find((candidate) => candidate.sourceEventId === "open-house@google.com");
    const conflicting = parseAeroeskoebingSejlklubCalendar(
      ics.replace("DESCRIPTION:Prøv en tur på vandet.", "DESCRIPTION:Kun for medlemmer."),
      NOW.toISOString(),
      NOW,
    ).candidates.find((candidate) => candidate.sourceEventId === "open-house@google.com");

    expect(negated?.attendance).toBe("unknown");
    expect(conflicting?.attendance).toBe("unknown");
  });

  it("bounds ancient weekly rules and skips nonexistent Copenhagen wall times", () => {
    const calendar = (event: string) => `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Ærøskøbing Sejlklub
X-WR-TIMEZONE:Europe/Copenhagen
BEGIN:VTIMEZONE
TZID:Europe/Copenhagen
END:VTIMEZONE
${event}
END:VCALENDAR`;
    const ancient = calendar(`BEGIN:VEVENT
UID:ancient-weekly@google.com
DTSTART;TZID=Europe/Copenhagen:00010101T180000
DTEND;TZID=Europe/Copenhagen:00010101T190000
RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20270920T160000Z;BYDAY=MO
SUMMARY:Historisk ugeregel
END:VEVENT`);
    const dstGap = calendar(`BEGIN:VEVENT
UID:dst-gap@google.com
DTSTART;TZID=Europe/Copenhagen:20270321T023000
DTEND;TZID=Europe/Copenhagen:20270321T033000
RRULE:FREQ=WEEKLY;WKST=MO;UNTIL=20270404T003000Z;BYDAY=SU
SUMMARY:Søndagssejlads
END:VEVENT`);
    const tooMany = calendar(
      Array.from({ length: 501 }, (_value, index) => `BEGIN:VEVENT
UID:bounded-${index}@google.com
DTSTART;VALUE=DATE:20261001
DTEND;VALUE=DATE:20261002
SUMMARY:Aktivitet ${index}
END:VEVENT`).join("\n"),
    );

    const ancientResult = parseAeroeskoebingSejlklubCalendar(
      ancient,
      NOW.toISOString(),
      NOW,
    );
    const dstResult = parseAeroeskoebingSejlklubCalendar(
      dstGap,
      NOW.toISOString(),
      NOW,
    );
    const oversizedResult = parseAeroeskoebingSejlklubCalendar(
      tooMany,
      NOW.toISOString(),
      NOW,
    );

    expect(ancientResult.errors).toEqual([]);
    expect(ancientResult.candidates).toHaveLength(1);
    expect(dstResult.errors).toEqual([]);
    expect(dstResult.candidates[0]!.occurrences.map((occurrence) => ({
      date: occurrence.date,
      startTime: occurrence.startTime,
    }))).toEqual([
      { date: "2027-03-21", startTime: "02:30" },
      { date: "2027-04-04", startTime: "02:30" },
    ]);
    expect(oversizedResult.rawEventCount).toBe(501);
    expect(oversizedResult.parsedCandidateCount).toBe(0);
    expect(oversizedResult.errors.join(" ")).toContain("flere end 500");
  }, 1_000);

  it("collects one pinned feed and preserves the snapshot when no accepted future event remains", async () => {
    const ics = await fixture("aeroeskoebing-sejlklub.ics");
    const result = await aeroeskoebingSejlklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: { status: 200, body: ics, contentType: "text/calendar; charset=utf-8" },
      }),
    });
    const onlyBookings = ics
      .replace("SUMMARY:Kapsejlads", "SUMMARY:Klubhus optaget")
      .replace("SUMMARY:1. bådoptagning", "SUMMARY:Klubhus optaget 2")
      .replace("SUMMARY:Vintermøde", "SUMMARY:Udlejet vinter")
      .replace("SUMMARY:ÅBENT HUS - prøv optimistjolle\n sejlads", "SUMMARY:Optaget")
      .replace("SUMMARY:Historisk klubaktivitet", "SUMMARY:Klubhus udlejet historisk");
    const empty = await aeroeskoebingSejlklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: { status: 200, body: onlyBookings, contentType: "text/calendar" },
      }),
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(1);
    expect(result.candidates).toHaveLength(4);
    expect(empty.status).toBe("partial");
    expect(empty.candidates).toEqual([]);
    expect(empty.errors.join(" ")).toContain("ingen fremtidige klubaktiviteter");
  });
});
