import { describe, expect, it } from "vitest";

import {
  campusPageUrl,
  campusSource,
  consolidateCampusWeeklySeries,
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

function weeklyEvent(options: {
  id: number;
  slug: string;
  date: string;
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  categorySlugs?: string[];
}) {
  return {
    id: options.id,
    slug: options.slug,
    status: "publish",
    title: options.title ?? "Ugentligt værksted",
    description: options.description ?? "Et ugentligt, offentligt værksted.",
    url: `https://campusaeroe.dk/event/${options.slug}/${options.date}/`,
    start_date: `${options.date} ${options.startTime ?? "18:30"}:00`,
    end_date: `${options.date} ${options.endTime ?? "20:30"}:00`,
    timezone: "Europe/Copenhagen",
    all_day: false,
    hide_from_listings: false,
    modified_utc: "2026-08-17 08:10:01",
    cost: "",
    website: "",
    event_status: "scheduled",
    venue: [],
    categories: (options.categorySlugs ?? ["campus-ugentlig"]).map((slug) => ({ slug })),
  };
}

function parsedWeeklyEvents(values: ReturnType<typeof weeklyEvent>[]) {
  const parsed = values.map((value) => parseCampusEvent(value, NOW.toISOString()));
  expect(parsed.flatMap((item) => item.errors)).toEqual([]);
  return consolidateCampusWeeklySeries(
    parsed.flatMap((item) => item.candidate ? [item.candidate] : []),
    parsed.flatMap((item) => item.seriesEvidence ? [item.seriesEvidence] : []),
  );
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

  it("consolidates Tribe recurrence instances under the stable slug without inventing dates", () => {
    const result = parsedWeeklyEvents([
      weeklyEvent({ id: 1001, slug: "aabent-vaerksted", date: "2026-10-19" }),
      weeklyEvent({ id: 1002, slug: "aabent-vaerksted", date: "2026-10-26" }),
      weeklyEvent({ id: 1003, slug: "aabent-vaerksted", date: "2026-11-09" }),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.absorbedSourceEventIds).toEqual(["1001", "1002", "1003"]);
    expect(result.retiredSeriesSourceEventIds).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "series-aabent-vaerksted",
      stableId: "campus-aeroe-series-aabent-vaerksted",
      provenance: {
        externalId: "series-aabent-vaerksted",
        sourceUrl: "https://campusaeroe.dk/event/aabent-vaerksted/",
      },
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-10-19", startTime: "18:30" },
        rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261109T183000",
        exdates: ["2026-11-02T18:30"],
        durationMinutes: 120,
      },
    });
    expect(result.candidates[0]?.occurrences.map((occurrence) => occurrence.id)).toEqual([
      "campus-1001",
      "campus-1002",
      "campus-1003",
    ]);
  });

  it("keeps same-slug instances separate when their event metadata differs", () => {
    const result = parsedWeeklyEvents([
      weeklyEvent({ id: 1001, slug: "aabent-vaerksted", date: "2026-10-19" }),
      weeklyEvent({
        id: 1002,
        slug: "aabent-vaerksted",
        date: "2026-10-26",
        title: "Ændret værksted",
      }),
    ]);

    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["1001", "1002"]);
    expect(result.absorbedSourceEventIds).toEqual([]);
    expect(result.retiredSeriesSourceEventIds).toEqual(["series-aabent-vaerksted"]);
    expect(result.warnings).toContain(
      "Campus-serien aabent-vaerksted har forskellig metadata mellem forekomster og bevares enkeltvis",
    );
  });

  it("requires the complete source category set to stay identical", () => {
    const result = parsedWeeklyEvents([
      weeklyEvent({ id: 1001, slug: "aabent-vaerksted", date: "2026-10-19" }),
      weeklyEvent({
        id: 1002,
        slug: "aabent-vaerksted",
        date: "2026-10-26",
        categorySlugs: ["campus-ugentlig", "ekstra"],
      }),
    ]);

    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["1001", "1002"]);
    expect(result.retiredSeriesSourceEventIds).toEqual(["series-aabent-vaerksted"]);
    expect(result.warnings).toContain(
      "Campus-serien aabent-vaerksted har forskellig metadata mellem forekomster og bevares enkeltvis",
    );
  });

  it("retires a former synthetic series identity when only one instance remains", () => {
    const result = parsedWeeklyEvents([
      weeklyEvent({ id: 1001, slug: "aabent-vaerksted", date: "2026-10-19" }),
    ]);

    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["1001"]);
    expect(result.absorbedSourceEventIds).toEqual([]);
    expect(result.retiredSeriesSourceEventIds).toEqual(["series-aabent-vaerksted"]);
  });

  it("routes conflicts between series prose and structured fields to review", () => {
    const result = parsedWeeklyEvents([
      weeklyEvent({
        id: 2001,
        slug: "havvaerk",
        date: "2026-09-15",
        title: "Havværk",
        description: "Hver tirsdag fra 17.25 til 20.15.",
        startTime: "17:25",
        endTime: "20:00",
      }),
      weeklyEvent({
        id: 2002,
        slug: "havvaerk",
        date: "2026-09-22",
        title: "Havværk",
        description: "Hver tirsdag fra 17.25 til 20.15.",
        startTime: "17:25",
        endTime: "20:00",
      }),
      weeklyEvent({
        id: 3001,
        slug: "campus-kunst",
        date: "2026-10-21",
        title: "CAMPUS-KUNST",
        description: "Hver mandag fra oktober til april er der åbent kunstværksted.",
      }),
      weeklyEvent({
        id: 3002,
        slug: "campus-kunst",
        date: "2026-10-28",
        title: "CAMPUS-KUNST",
        description: "Hver mandag fra oktober til april er der åbent kunstværksted.",
      }),
    ]);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.publication === "review")).toBe(true);
    expect(result.candidates.find((candidate) => candidate.sourceEventId === "series-havvaerk")?.reviewReasons)
      .toContain(
        "Kildeteksten angiver kl. 17:25–20:15, men de strukturerede Campus-felter angiver kl. 17:25–20:00; de strukturerede tider er bevaret.",
      );
    expect(result.candidates.find((candidate) => candidate.sourceEventId === "series-campus-kunst")?.reviewReasons)
      .toContain(
        "Kildeteksten angiver \"hver mandag\", men de strukturerede Campus-forekomster ligger om onsdagen; den strukturerede ugedag er bevaret.",
      );
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
