import { describe, expect, it } from "vitest";

import {
  MARNAV_DISCOVERY_URL,
  marnavSource,
  parseMarnavDiscovery,
  parseMarnavEvent,
} from "../../scripts/sources/marnav";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();
const EVENT_647 = "https://marnav.nemtilmeld.dk/647/";
const EVENT_648 = "https://marnav.nemtilmeld.dk/648/";

describe("Marstal Navigationsskole NemTilmeld source", () => {
  it("discovers only public numeric Åbent hus links and deduplicates them", async () => {
    const parsed = parseMarnavDiscovery(await fixture("marnav-discovery.html"));

    expect(parsed.errors).toEqual([]);
    expect(parsed.urls).toEqual([EVENT_647, EVENT_648]);
    expect(parsed.warnings).toContain("MarNavs eventliste gentog et Åbent hus-link");
  });

  it("parses schema.org Event data and visible sold-out/waitlist state", async () => {
    const html = await fixture("marnav-event-647.html");
    const parsed = parseMarnavEvent(html, EVENT_647, RETRIEVED_AT);

    expect(parsed.errors).toEqual([]);
    expect(parsed.excluded).toBe(false);
    expect(parsed.candidate).toMatchObject({
      sourceEventId: "647",
      stableId: "marnav-647",
      title: "Åbent hus den 16. januar 2027",
      status: "scheduled",
      availability: "sold-out",
      attendance: "registration",
      bookingUrl: EVENT_647,
      bookingRequired: true,
      bookingDetails: "Udsolgt; venteliste er åben.",
      publication: "trusted",
      location: {
        name: "Marstal Navigationsskole",
        address: "Ellenet 10",
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [{ date: "2027-01-16", startTime: "11:00", endTime: "15:30" }],
    });

    const moved = parseMarnavEvent(
      html.replaceAll("2027-01-16", "2027-01-17"),
      EVENT_647,
      RETRIEVED_AT,
    );
    expect(moved.candidate?.stableId).toBe(parsed.candidate?.stableId);
  });

  it("re-applies the narrow allowlist on every event detail", async () => {
    const unrelated = (await fixture("marnav-event-647.html")).replace(
      "Åbent hus den 16. januar 2027",
      "Radar-kursus den 16. januar 2027",
    );
    const parsed = parseMarnavEvent(unrelated, EVENT_647, RETRIEVED_AT);

    expect(parsed.excluded).toBe(true);
    expect(parsed.candidate).toBeUndefined();
    expect(parsed.warnings[0]).toContain("ikke på allowlisten");
  });

  it("rejects a detail parser call whose source URL leaves the tenant origin", async () => {
    const parsed = parseMarnavEvent(
      await fixture("marnav-event-647.html"),
      "https://evil.example/647/",
      RETRIEVED_AT,
    );

    expect(parsed.candidate).toBeUndefined();
    expect(parsed.errors.some((error) => error.includes("NemTilmeld-linket er usikkert"))).toBe(true);
  });

  it("collects every discovered detail into one atomic snapshot", async () => {
    const result = await marnavSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [MARNAV_DISCOVERY_URL]: await fixture("marnav-discovery.html"),
        [EVENT_647]: await fixture("marnav-event-647.html"),
        [EVENT_648]: await fixture("marnav-event-648.html"),
      }),
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(3);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["647", "648"]);
    expect(result.candidates.every((candidate) => candidate.availability === "sold-out")).toBe(true);
  });

  it("rejects an unsafe canonical link and discards the whole snapshot", async () => {
    const unsafe = (await fixture("marnav-event-648.html")).replace(
      "https://marnav.nemtilmeld.dk/648/",
      "https://evil.example/648/",
    );
    const result = await marnavSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [MARNAV_DISCOVERY_URL]: await fixture("marnav-discovery.html"),
        [EVENT_647]: await fixture("marnav-event-647.html"),
        [EVENT_648]: unsafe,
      }),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(1);
    expect(result.errors.some((error) => error.includes("usikkert kanonisk link"))).toBe(true);
  });
});
