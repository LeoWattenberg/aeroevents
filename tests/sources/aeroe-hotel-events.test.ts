import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import {
  AEROE_HOTEL_MAX_BODY_BYTES,
  AEROE_HOTEL_MAX_EVENTS,
  WIX_EVENTS_APP_ID,
  aeroeHotelEventsSource,
  parseAeroeHotelEventsPage,
} from "../../scripts/sources/aeroe-hotel-events";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const SOURCE_URL = "https://www.aeroehotel.dk/event-list";

type FixtureEvent = Record<string, unknown>;
interface FixtureWarmup {
  appsWarmupData: Record<string, Record<string, { events: { events: FixtureEvent[] } }>>;
}

function modifyWarmup(html: string, change: (events: FixtureEvent[]) => void): string {
  const $ = load(html);
  const raw = $("#wix-warmup-data").html()!;
  const warmup = JSON.parse(raw) as FixtureWarmup;
  const state = Object.values(warmup.appsWarmupData[WIX_EVENTS_APP_ID]!)[0]!;
  change(state.events.events);
  return html.replace(raw, JSON.stringify(warmup));
}

describe("Ærø Hotel Wix Events source", () => {
  it("parses warmup records, deduplicates UUIDs, and uses only the scheduling interval", async () => {
    const parsed = parseAeroeHotelEventsPage(
      await fixture("aeroe-hotel-events.html"),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rawEventCount).toBe(4);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.warnings[0]).toContain("1 event-UUID");
    expect(parsed.candidates[0]).toMatchObject({
      stableId: "aeroe-hotel-events-ed1de5fe-85ed-4ca4-9219-f9ecb19eb760",
      title: "Koncert: Johnny Hansen",
      description: "Koncertophold med ankomst 5. oktober og afrejse 7. oktober 2026.",
      location: { name: "Sted er ikke bestemt endnu" },
      occurrences: [{ date: "2026-10-06", startTime: "21:00", endTime: "23:00" }],
      attendance: "registration",
      availability: "unknown",
      bookingUrl: "https://www.aeroehotel.dk/event-details/koncert-johnny-hansen-1",
      bookingRequired: true,
      publication: "review",
      provenance: { sourceModifiedAt: "2026-05-13T22:07:57.000Z" },
    });
    expect(parsed.candidates[0]!.reviewReasons.join(" ")).toContain("ikke fastlagt");
    expect(parsed.candidates[1]).toMatchObject({
      publication: "trusted",
      reviewReasons: [],
      location: {
        name: "Ærø Hotel",
        address: "Egehovedvej 4",
        postalCode: "5960",
        city: "Marstal",
      },
    });
    expect(parsed.candidates[2]).toMatchObject({
      availability: "sold-out",
      bookingDetails: expect.stringContaining("udsolgt"),
    });
  });

  it("strictly validates the hotel origin, Wix app identity, and canonical event slug", async () => {
    const fixtureHtml = await fixture("aeroe-hotel-events.html");
    const wrongSite = parseAeroeHotelEventsPage(
      fixtureHtml.replace("https://www.aeroehotel.dk\"},\"requestUrl", "https://evil.example\"},\"requestUrl"),
      NOW.toISOString(),
    );
    const wrongMetaSite = parseAeroeHotelEventsPage(
      fixtureHtml.replace(
        "81da065d-53cf-4d56-991b-3817fa31d9c3",
        "11111111-1111-4111-8111-111111111111",
      ),
      NOW.toISOString(),
    );
    const wrongApp = parseAeroeHotelEventsPage(
      fixtureHtml.replace(WIX_EVENTS_APP_ID, "22222222-2222-4222-8222-222222222222"),
      NOW.toISOString(),
    );
    const unsafeSlug = parseAeroeHotelEventsPage(
      modifyWarmup(fixtureHtml, (events) => {
        events[0]!.slug = "../../outside";
      }),
      NOW.toISOString(),
    );

    expect(wrongSite.errors.some((error) => error.includes("ikke Ærø Hotels origin"))).toBe(true);
    expect(wrongMetaSite.errors.some((error) => error.includes("forkert metaSiteId"))).toBe(true);
    expect(wrongApp.errors.some((error) => error.includes("mangler Ærø Hotels Wix Events-app"))).toBe(true);
    expect(unsafeSlug.errors.some((error) => error.includes("eventslug er ugyldigt"))).toBe(true);
  });

  it("treats conflicting copies and malformed event-like records as errors", async () => {
    const fixtureHtml = await fixture("aeroe-hotel-events.html");
    const conflict = parseAeroeHotelEventsPage(
      modifyWarmup(fixtureHtml, (events) => {
        events.at(-1)!.title = "En modstridende titel";
      }),
      NOW.toISOString(),
    );
    const malformed = modifyWarmup(fixtureHtml, (events) => {
      events.push({
        id: "11111111-1111-4111-8111-111111111111",
        title: "Ligner et event, men mangler resten",
      });
    });
    const result = await aeroeHotelEventsSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: malformed }),
    });

    expect(conflict.errors.some((error) => error.includes("modstridende kernefelter"))).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(3);
  });

  it("caps both event count and response body size", async () => {
    const fixtureHtml = await fixture("aeroe-hotel-events.html");
    const tooMany = parseAeroeHotelEventsPage(
      modifyWarmup(fixtureHtml, (events) => {
        events.push(...Array.from({ length: AEROE_HOTEL_MAX_EVENTS }, () => ({ ...events[0]! })));
      }),
      NOW.toISOString(),
    );
    const oversized = await aeroeHotelEventsSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: "x".repeat(AEROE_HOTEL_MAX_BODY_BYTES + 1) }),
    });

    expect(tooMany.errors.some((error) => error.includes(`flere end ${AEROE_HOTEL_MAX_EVENTS}`))).toBe(true);
    expect(oversized.status).toBe("failed");
    expect(oversized.pagesFetched).toBe(0);
    expect(oversized.errors[0]).toContain("overstiger grænsen");
  });

  it("routes different-UUID semantic duplicates to review when more than one is trusted", async () => {
    const fixtureHtml = await fixture("aeroe-hotel-events.html");
    const duplicate = parseAeroeHotelEventsPage(
      modifyWarmup(fixtureHtml, (events) => {
        events.push({
          ...structuredClone(events[1]!),
          id: "11111111-1111-4111-8111-111111111111",
          slug: "koncert-johnny-hansen-copy",
        });
      }),
      NOW.toISOString(),
    );
    const matching = duplicate.candidates.filter((candidate) =>
      candidate.title === "Koncert: Johnny Hansen" && candidate.publication === "review"
    );

    expect(matching).toHaveLength(3);
    expect(matching.filter((candidate) =>
      candidate.reviewReasons.includes("Flere strukturelt komplette Wix-poster har samme titel og tidspunkt.")
    )).toHaveLength(2);
    expect(duplicate.warnings.join(" ")).toContain("forskellige UUID'er");
  });

  it("returns only current events and trusts only unambiguous records", async () => {
    const result = await aeroeHotelEventsSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: await fixture("aeroe-hotel-events.html") }),
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(1);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "ed1de5fe-85ed-4ca4-9219-f9ecb19eb760",
      "a3408796-d514-413e-a85f-e29878626aa1",
    ]);
    expect(result.candidates.map((candidate) => candidate.publication)).toEqual([
      "review",
      "trusted",
    ]);
    expect(result.candidates[0]!.reviewReasons.length).toBeGreaterThan(0);
    expect(result.candidates[1]!.reviewReasons).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("9846b240"))).toBe(true);
  });
});
