import { describe, expect, it } from "vitest";

import {
  parseRiseBookings,
  parseRiseResources,
  riseSifSource,
} from "../../scripts/sources/rise-sif";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RESOURCES =
  "https://www.conventus.dk/publicBooking/public/getResources?organization=206";
const BOOKINGS = "https://www.conventus.dk/publicBooking/public/getBookings";

describe("Rise SIF source", () => {
  it("discovers only the allowlisted public activity resources", async () => {
    const parsed = parseRiseResources(JSON.parse(await fixture("rise-resources.json")));
    expect(parsed).toEqual({ resourceIds: [247, 248], errors: [] });
  });

  it("groups series by stable id and excludes room reservations", async () => {
    const parsed = parseRiseBookings(
      JSON.parse(await fixture("rise-bookings.json")),
      [247, 248],
      NOW.toISOString(),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[1]).toMatchObject({
      sourceEventId: "series-738768",
      stableId: "rise-sif-series-738768",
      attendance: "members",
      publication: "trusted",
    });
    expect(parsed.candidates[1]!.occurrences).toHaveLength(2);
    expect(parsed.candidates.some((candidate) => candidate.title.includes("fødselsdag"))).toBe(false);
    expect(JSON.stringify(parsed.candidates)).not.toContain("må aldrig gemmes");
    expect(parsed.candidates[0]).toMatchObject({
      sourceEventId: "booking-22345043",
      publication: "review",
    });
  });

  it("posts a bounded request and records a participant-free raw response", async () => {
    const captured: string[] = [];
    let bookingInit: RequestInit | undefined;
    const baseFetch = mappedFetch({
      [RESOURCES]: await fixture("rise-resources.json"),
      [BOOKINGS]: await fixture("rise-bookings.json"),
    });
    const result = await riseSifSource.collect({
      now: NOW,
      fetch: async (input, init) => {
        if (String(input) === BOOKINGS) bookingInit = init;
        return baseFetch(input, init);
      },
      recordResponse: async (response) => {
        captured.push(response.body);
      },
    });
    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(bookingInit?.method).toBe("POST");
    expect(String(bookingInit?.body)).toContain('"resourceList":[{"id":247},{"id":248}]');
    expect(captured).toHaveLength(2);
    expect(captured[1]).not.toContain("må aldrig gemmes");
  });

  it("rejects a malformed selected activity without exposing a partial snapshot", async () => {
    const malformed = JSON.parse(await fixture("rise-bookings.json"));
    malformed[0].bookings[0].end = malformed[0].bookings[0].start;
    const result = await riseSifSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [RESOURCES]: await fixture("rise-resources.json"),
        [BOOKINGS]: JSON.stringify(malformed),
      }),
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
