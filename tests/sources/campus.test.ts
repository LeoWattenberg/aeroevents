import { describe, expect, it } from "vitest";

import {
  campusPageUrl,
  campusSource,
  parseCampusEvent,
  parseCampusPage,
} from "../../scripts/sources/campus";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Campus Ærø Tribe REST source", () => {
  it("decodes Tribe fields and trusts allowlisted public event metadata", async () => {
    const fixturePage = JSON.parse(await fixture("campus-page-1.json"));
    const parsed = parseCampusEvent(fixturePage.events[0], NOW.toISOString());

    expect(parsed.errors).toEqual([]);
    expect(parsed.excluded).toBe(false);
    expect(parsed.candidate).toMatchObject({
      stableId: "campus-aeroe-8001",
      title: "Foredrag & fællesspisning",
      categoryIds: ["musik-kultur"],
      publication: "trusted",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://billet.example/campus-8001",
      price: "0 kr.",
      location: {
        name: "Campus Ærø",
        address: "Ellenet 10",
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [{ date: "2026-10-22", startTime: "18:30", endTime: "21:00" }],
      provenance: { sourceModifiedAt: "2026-09-02T10:15:00.000Z" },
    });
    expect(parsed.candidate?.reviewReasons).toEqual([]);
  });

  it("excludes restricted audiences even in an allowed category", async () => {
    const fixturePage = JSON.parse(await fixture("campus-page-1.json"));
    const parsed = parseCampusEvent(fixturePage.events[1], NOW.toISOString());

    expect(parsed.errors).toEqual([]);
    expect(parsed.excluded).toBe(true);
    expect(parsed.excludedReason).toContain("kun er for");
    expect(parsed.candidate).toBeUndefined();

    const hidden = parseCampusEvent(
      { ...fixturePage.events[0], hide_from_listings: true },
      NOW.toISOString(),
    );
    expect(hidden.excluded).toBe(true);
    expect(hidden.excludedReason).toContain("skjult");
  });

  it("validates pagination, reports exclusions, and preserves postponed/sold-out state", async () => {
    const first = parseCampusPage(
      JSON.parse(await fixture("campus-page-1.json")),
      NOW.toISOString(),
      1,
    );
    const second = parseCampusPage(
      JSON.parse(await fixture("campus-page-2.json")),
      NOW.toISOString(),
      2,
    );

    expect(first.errors).toEqual([]);
    expect(first.page).toMatchObject({ itemCount: 2, excludedCount: 1 });
    expect(first.warnings.some((warning) => warning.includes("1 poster blev udeladt"))).toBe(true);
    expect(second.errors).toEqual([]);
    expect(second.page?.candidates[0]).toMatchObject({
      stableId: "campus-aeroe-8102",
      status: "postponed",
      availability: "sold-out",
      bookingUrl: "https://booking.example/campus-8102",
    });
  });

  it("walks all REST pages and returns only allowlisted public candidates", async () => {
    const responses: Record<string, string> = {
      [campusPageUrl(1, NOW)]: await fixture("campus-page-1.json"),
      [campusPageUrl(2, NOW)]: await fixture("campus-page-2.json"),
    };
    const result = await campusSource.collect({
      now: NOW,
      fetch: async (input) => {
        const body = responses[String(input)];
        return body ? jsonResponse(body) : jsonResponse("{}", 404);
      },
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["8001", "8102"]);
  });

  it("atomically discards an earlier page when a later page is malformed", async () => {
    const first = await fixture("campus-page-1.json");
    const result = await campusSource.collect({
      now: NOW,
      fetch: async (input) =>
        String(input) === campusPageUrl(1, NOW)
          ? jsonResponse(first)
          : jsonResponse("not-json"),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(1);
  });
});
