import { describe, expect, it } from "vitest";

import { marstalIfSource, parseMarstalIfPage } from "../../scripts/sources/marstal-if";
import { fixture, mappedFetch } from "./test-helpers";

const URL = "https://www.marstalif.dk/fodbold/kommende-kampe/";
const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

describe("Marstal IF upcoming matches source", () => {
  it("collects future Marstal home matches and filters past, away, and non-local rows", async () => {
    const result = await marstalIfSource.collect({
      fetch: mappedFetch({ [URL]: await fixture("marstal-if.html") }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("historiske");
    expect(result.warnings.join(" ")).toContain("udekamp");
    expect(result.warnings.join(" ")).toContain("uden for Marstal Stadion");
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "633168",
      stableId: "marstal-if-633168",
      title: "Marstal/Rise – FC Kurant",
      description: "Herrer S4, Efterår 2026 • Pulje 2",
      organizerId: "marstal-if",
      categoryIds: ["sport-motion"],
      location: { name: "Kortermann-IT stadion, Marstal" },
      occurrences: [{
        id: "dbu-633168",
        date: "2026-09-18",
        startTime: "17:50",
        allDay: false,
        timeUnknown: false,
      }],
      status: "scheduled",
      attendance: "public",
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        externalId: "633168",
        sourceUrl: "https://www.marstalif.dk/kampvisning?poolrowid=501669&matchid=633168",
      },
    });
    expect(result.candidates[1]).toMatchObject({
      sourceEventId: "289082",
      status: "postponed",
    });
    expect(result.candidates[2]).toMatchObject({
      sourceEventId: "699999",
      status: "cancelled",
    });
    expect(result.candidates.some((candidate) => candidate.sourceEventId === "285007")).toBe(false);
    if (result.status === "complete") {
      expect(result.excludedSourceEventIds).toEqual(["285007", "630001", "659515"]);
    }
  });

  it("keeps matchid and poolrowid identity when a match date moves", async () => {
    const html = (await fixture("marstal-if.html"))
      .replace('<div class="date">18.</div><div class="weekday">fredag</div><span>17.50</span>', '<div class="date">25.</div><div class="weekday">fredag</div><span>18.30</span>');
    const parsed = parseMarstalIfPage(html, RETRIEVED_AT, NOW);
    const moved = parsed.candidates.find((candidate) => candidate.sourceEventId === "633168");

    expect(parsed.errors).toEqual([]);
    expect(moved).toMatchObject({
      stableId: "marstal-if-633168",
      occurrences: [{ id: "dbu-633168", date: "2026-09-25", startTime: "18:30" }],
    });
  });

  it("returns an atomic partial result when a match row is malformed", async () => {
    const html = (await fixture("marstal-if.html")).replace("17.50", "ukendt");
    const result = await marstalIfSource.collect({ fetch: mappedFetch({ [URL]: html }), now: NOW });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("dato eller tid");
    if (result.status === "partial") expect(result.discardedCandidateCount).toBe(2);
  });

  it("rejects cross-origin match links without exposing other candidates", async () => {
    const html = (await fixture("marstal-if.html")).replace(
      "/kampvisning?poolrowid=501669&amp;matchid=633168",
      "https://example.invalid/kampvisning?poolrowid=501669&amp;matchid=633168",
    );
    const result = await marstalIfSource.collect({ fetch: mappedFetch({ [URL]: html }), now: NOW });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("usikkert link");
  });

  it("rejects source fields outside the public model bounds atomically", async () => {
    const html = await fixture("marstal-if.html");
    const oversizedId = await marstalIfSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [URL]: html.replace("matchid=633168", `matchid=${"9".repeat(21)}`),
      }),
    });
    const oversizedTeam = await marstalIfSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [URL]: html.replace(
          '<span class="homeTeamName">Marstal/Rise</span>',
          `<span class="homeTeamName">${"A".repeat(111)}</span>`,
        ),
      }),
    });

    expect(oversizedId.status).toBe("partial");
    expect(oversizedId.candidates).toEqual([]);
    expect(oversizedId.errors.join(" ")).toContain("mangler stabilt matchid");
    expect(oversizedTeam.status).toBe("partial");
    expect(oversizedTeam.candidates).toEqual([]);
    expect(oversizedTeam.errors.join(" ")).toContain("for langt holdnavn");
  });

  it("fails before parsing when the direct source request fails", async () => {
    const result = await marstalIfSource.collect({
      fetch: mappedFetch({ [URL]: { status: 503 } }),
      now: NOW,
    });

    expect(result.status).toBe("failed");
    expect(result.candidates).toEqual([]);
    expect(result.pagesFetched).toBe(0);
  });
});
