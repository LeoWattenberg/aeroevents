import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { sourceDraftToEvent } from "../../scripts/cli/model";
import { folkedansSource, parseFolkedansPage } from "../../scripts/sources/folkedans";
import { CALENDAR_ZONE, expandEvent } from "../../src/lib/schedule";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const URL = "https://6165826142842.site123.me/";

const ADULT_SERIES_DATES = [
  "2026-09-15",
  "2026-09-22",
  "2026-09-29",
  "2026-10-06",
  "2026-10-20",
  "2026-10-27",
  "2026-11-03",
  "2026-11-10",
  "2026-11-17",
  "2026-11-24",
  "2027-01-05",
  "2027-01-12",
  "2027-01-19",
  "2027-01-26",
  "2027-02-02",
  "2027-02-09",
  "2027-02-23",
  "2027-03-02",
  "2027-03-09",
  "2027-03-16",
] as const;

function usDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

function adultSeriesHtml(changeDescriptionAt?: number): string {
  const cards = ADULT_SERIES_DATES.map((date, index) => {
    const suffix = index === 0 ? "" : `-${index}`;
    const description = index === changeDescriptionAt ? "En anden aktivitet." : "Kom og dans med os.";
    return `<div class="event" data-unique-id="adult-${String(index).padStart(2, "0")}">
      <div class="event-title"><a href="/begivenheder/folkedans-for-alle-unge-og-voksne${suffix}">Folkedans for alle (unge og voksne)</a></div>
      <ul class="event-meta">
        <li><i data-icon-name="clock-o"></i>${usDate(date)} 06:30 PM - ${usDate(date)} 08:45 PM</li>
        <li><i data-icon-name="map-marker"></i>Pilebækken 30, Ærøskøbing, Danmark</li>
      </ul>
      <div class="event-content"><p>${description}</p></div>
    </div>`;
  });
  return `<!doctype html><div class="events-container">
    <div data-event-filter="kommende-begivenheder"><div class="events">${cards.join("")}</div></div>
  </div>`;
}

describe("Ærø Folkedanserforening source", () => {
  it("uses only upcoming events and deduplicates Site123's repeated module", async () => {
    const result = await folkedansSource.collect({
      fetch: mappedFetch({ [URL]: await fixture("folkedans.html") }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("dubletter");
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).not.toContain("old-event");
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeroe-folkedans-6a93f435e375d",
      price: "25 kr",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://6165826142842.site123.me/begivenheder/familiedans#tilmeld",
      location: { name: "Pilebækken 30", city: "Ærøskøbing" },
      occurrences: [{ date: "2026-09-15", startTime: "16:30", endTime: "17:30" }],
    });
  });

  it("treats an equal Site123 end time as an omitted duration", async () => {
    const parsed = parseFolkedansPage(await fixture("folkedans.html"), NOW.toISOString());
    const candidate = parsed.candidates.find((value) => value.sourceEventId === "6a93f65a93765")!;
    expect(candidate.publication).toBe("trusted");
    expect(candidate.reviewReasons).toEqual([]);
    expect(candidate.occurrences[0]).toMatchObject({ startTime: "18:30" });
    expect(candidate.occurrences[0]).not.toHaveProperty("endTime");
    expect(parsed.warnings.join(" ")).toContain("sluttidspunktet blev udeladt");
  });

  it("collapses the exact adult ordinal-slug series without changing its occurrences", () => {
    const parsed = parseFolkedansPage(adultSeriesHtml(), NOW.toISOString());

    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.excludedSourceEventIds).toHaveLength(20);
    expect(parsed.candidates).toHaveLength(1);
    const series = parsed.candidates[0]!;
    expect(series).toMatchObject({
      sourceEventId: "adult-series-2026-27",
      stableId: "aeroe-folkedans-adult-series-2026-27",
      title: "Folkedans for alle (unge og voksne)",
      provenance: {
        externalId: "adult-series-2026-27",
        sourceUrl: "https://6165826142842.site123.me/begivenheder/folkedans-for-alle-unge-og-voksne",
      },
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-09-15", startTime: "18:30" },
        rrule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270316T183000",
        durationMinutes: 135,
        exdates: [
          "2026-10-13T18:30",
          "2026-12-01T18:30",
          "2026-12-08T18:30",
          "2026-12-15T18:30",
          "2026-12-22T18:30",
          "2026-12-29T18:30",
          "2027-02-16T18:30",
        ],
      },
    });
    expect(series.occurrences).toHaveLength(20);

    const expanded = expandEvent(
      sourceDraftToEvent(series),
      DateTime.fromISO("2026-09-15", { zone: CALENDAR_ZONE }),
      DateTime.fromISO("2027-03-16", { zone: CALENDAR_ZONE }),
    );
    expect(expanded.warnings).toEqual([]);
    expect(expanded.occurrences.map((occurrence) => ({
      date: occurrence.date,
      startTime: DateTime.fromISO(occurrence.startAt!, { setZone: true }).toFormat("HH:mm"),
      endTime: DateTime.fromISO(occurrence.endAt!, { setZone: true }).toFormat("HH:mm"),
    }))).toEqual(series.occurrences.map((occurrence) => ({
      date: occurrence.date,
      startTime: occurrence.startTime,
      endTime: occurrence.endTime,
    })));
  });

  it("leaves adult ordinal slugs explicit when their metadata conflicts", () => {
    const parsed = parseFolkedansPage(adultSeriesHtml(7), NOW.toISOString());

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(20);
    expect(parsed.candidates.every((candidate) => candidate.schedule === undefined)).toBe(true);
    expect(parsed.excludedSourceEventIds).toEqual(["adult-series-2026-27"]);
    expect(parsed.warnings.join(" ")).toContain("modstridende metadata");
  });

  it("keeps a reversed Site123 interval in review", async () => {
    const html = (await fixture("folkedans.html")).replaceAll(
      "09/22/2026 06:30 PM - 09/22/2026 06:30 PM",
      "09/22/2026 06:30 PM - 09/22/2026 05:30 PM",
    );
    const candidate = parseFolkedansPage(html, NOW.toISOString()).candidates.find(
      (value) => value.sourceEventId === "6a93f65a93765",
    )!;
    expect(candidate.publication).toBe("review");
    expect(candidate.reviewReasons.join(" ")).toContain("før starttidspunktet");
  });

  it("does not expose any candidates when one upcoming event is malformed", async () => {
    const malformed = (await fixture("folkedans.html")).replaceAll(
      "09/22/2026 06:30 PM - 09/22/2026 06:30 PM",
      "ukendt tidspunkt",
    );
    const result = await folkedansSource.collect({
      fetch: mappedFetch({ [URL]: malformed }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
