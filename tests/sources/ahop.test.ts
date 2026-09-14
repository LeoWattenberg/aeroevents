import { describe, expect, it } from "vitest";

import {
  AHOP_API_URL,
  AHOP_PAGE_IDS,
  ahopSource,
  MAX_AHOP_RESPONSE_RECORDS,
  parseAhopPages,
} from "../../scripts/sources/ahop";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

async function pagesFixture(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await fixture("ahop-pages.json")) as Array<Record<string, unknown>>;
}

function pageById(
  pages: Array<Record<string, unknown>>,
  id: number,
): Record<string, unknown> {
  const page = pages.find((item) => item.id === id);
  if (!page) throw new Error(`Fixture mangler AHOP-side ${id}`);
  return page;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

describe("Aktivitetshuset OvenPaa WordPress source", () => {
  it("builds seven review-only weekly schedules with stable page-ID identities", async () => {
    const parsed = parseAhopPages(await pagesFixture(), RETRIEVED_AT);

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates.map((candidate) => candidate.sourceEventId)).toEqual(
      AHOP_PAGE_IDS.map((id) => `page-${id}`),
    );
    expect(parsed.candidates.map((candidate) => candidate.stableId)).toEqual(
      AHOP_PAGE_IDS.map((id) => `ahop-page-${id}`),
    );
    expect(parsed.candidates.every((candidate) => candidate.publication === "review")).toBe(true);
    expect(parsed.candidates.every((candidate) => candidate.occurrences.length === 0)).toBe(true);
    expect(parsed.candidates.map((candidate) => candidate.schedule)).toMatchObject([
      { startDateUnknown: true, dtstart: { date: "2000-01-03", startTime: "18:30" }, rrule: "FREQ=WEEKLY;BYDAY=MO", durationMinutes: 150 },
      { startDateUnknown: true, dtstart: { date: "2000-01-05", startTime: "14:00" }, rrule: "FREQ=WEEKLY;BYDAY=WE", durationMinutes: 120 },
      { startDateUnknown: true, dtstart: { date: "2000-01-04", startTime: "19:00" }, rrule: "FREQ=WEEKLY;BYDAY=TU", durationMinutes: 120 },
      { startDateUnknown: true, dtstart: { date: "2000-01-05", startTime: "19:00" }, rrule: "FREQ=WEEKLY;BYDAY=WE", durationMinutes: 120 },
      { startDateUnknown: true, dtstart: { date: "2000-01-04", startTime: "19:00" }, rrule: "FREQ=WEEKLY;BYDAY=TU" },
      { startDateUnknown: true, dtstart: { date: "2000-01-06", startTime: "19:00" }, rrule: "FREQ=WEEKLY;BYDAY=TH" },
      { startDateUnknown: true, dtstart: { date: "2000-01-05", startTime: "14:00" }, rrule: "FREQ=WEEKLY;BYDAY=WE", durationMinutes: 120 },
    ]);

    const ceramic = parsed.candidates.find((candidate) => candidate.sourceEventId === "page-276")!;
    const weaving = parsed.candidates.find((candidate) => candidate.sourceEventId === "page-28")!;
    expect(ceramic.schedule).not.toHaveProperty("durationMinutes");
    expect(weaving.schedule).not.toHaveProperty("durationMinutes");
    expect(ceramic.reviewReasons.join(" ")).toContain("ingen sluttid");
    expect(parsed.candidates.map((candidate) => [candidate.sourceEventId, candidate.attendance])).toEqual([
      ["page-42", "unknown"],
      ["page-31", "unknown"],
      ["page-32", "unknown"],
      ["page-33", "unknown"],
      ["page-276", "members"],
      ["page-28", "members"],
      ["page-41", "members"],
    ]);
  });

  it("uses the body weekday when WordPress title and body conflict", async () => {
    const parsed = parseAhopPages(await pagesFixture(), RETRIEVED_AT);
    const conflicted = parsed.candidates.find((candidate) => candidate.sourceEventId === "page-33");

    expect(conflicted).toMatchObject({
      title: "Strik onsdag aften",
      schedule: {
        dtstart: { startTime: "19:00" },
        rrule: "FREQ=WEEKLY;BYDAY=WE",
        durationMinutes: 120,
      },
    });
    expect(conflicted?.reviewReasons.join(" ")).toContain("strider mod brødteksten");
    expect(parsed.warnings.join(" ")).toContain("WordPress-titlens ugedag");
  });

  it("preserves canonical page URLs and Copenhagen-local modified timestamps", async () => {
    const parsed = parseAhopPages(await pagesFixture(), RETRIEVED_AT);
    const dart = parsed.candidates.find((candidate) => candidate.sourceEventId === "page-42");
    const woodwork = parsed.candidates.find((candidate) => candidate.sourceEventId === "page-41");

    expect(dart?.provenance).toMatchObject({
      externalId: "page-42",
      sourceUrl: "https://ahop.dk/dart/",
      sourceModifiedAt: "2026-05-20T12:29:05.000Z",
    });
    expect(woodwork?.provenance).toMatchObject({
      sourceUrl: "https://ahop.dk/traevaerksted/",
      sourceModifiedAt: "2026-09-14T08:19:09.000Z",
    });

    const unsafe = await pagesFixture();
    pageById(unsafe, 42).link = "https://evil.example/dart/";
    const rejected = parseAhopPages(unsafe, RETRIEVED_AT);
    expect(rejected.candidates).toEqual([]);
    expect(rejected.errors.join(" ")).toContain("sikre canonical-link");
  });

  it("collects the allowlist in one capped JSON request", async () => {
    const pages = await pagesFixture();
    const requested: string[] = [];
    const result = await ahopSource.collect({
      now: NOW,
      fetch: async (input) => {
        requested.push(String(input));
        return jsonResponse(pages);
      },
    });

    expect(requested).toEqual([AHOP_API_URL]);
    const request = new URL(AHOP_API_URL);
    expect(request.searchParams.get("per_page")).toBe("7");
    expect(request.searchParams.get("include")?.split(",").map(Number).sort((a, b) => a - b)).toEqual(
      [...AHOP_PAGE_IDS].sort((a, b) => a - b),
    );
    expect(result).toMatchObject({
      status: "complete",
      pagesFetched: 1,
      snapshotCoverage: "authoritative",
      candidates: expect.any(Array),
    });
    expect(result.candidates).toHaveLength(7);

    const oversized = parseAhopPages(
      Array.from({ length: MAX_AHOP_RESPONSE_RECORDS + 1 }, (_value, index) => ({ id: 10_000 + index })),
      RETRIEVED_AT,
    );
    expect(oversized.errors.join(" ")).toContain(`flere end ${MAX_AHOP_RESPONSE_RECORDS}`);
  });

  it("atomically rejects a missing allowlisted page", async () => {
    const pages = (await pagesFixture()).filter((page) => page.id !== 31);
    const result = await ahopSource.collect({ now: NOW, fetch: async () => jsonResponse(pages) });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("31");
    if (result.status === "partial") expect(result.discardedCandidateCount).toBe(6);
  });

  it("atomically rejects a malformed body rule", async () => {
    const pages = await pagesFixture();
    const dart = pageById(pages, 42);
    const content = dart.content as Record<string, unknown>;
    content.rendered = String(content.rendered).replace("18.30-21", "18.30-xx");
    const parsed = parseAhopPages(pages, RETRIEVED_AT);

    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors.join(" ")).toContain("ugeregel i brødteksten");
    expect(parsed.discardedCandidateCount).toBe(6);
  });

  it("atomically rejects duplicate or non-public allowlisted page identities", async () => {
    const duplicated = await pagesFixture();
    duplicated.push(structuredClone(pageById(duplicated, 42)));
    const duplicateResult = parseAhopPages(duplicated, RETRIEVED_AT);
    expect(duplicateResult.candidates).toEqual([]);
    expect(duplicateResult.errors.join(" ")).toContain("42 flere gange");

    for (const mutate of [
      (page: Record<string, unknown>) => { page.status = "private"; },
      (page: Record<string, unknown>) => {
        (page.content as Record<string, unknown>).protected = true;
      },
    ]) {
      const pages = await pagesFixture();
      mutate(pageById(pages, 276));
      const privateResult = parseAhopPages(pages, RETRIEVED_AT);
      expect(privateResult.candidates).toEqual([]);
      expect(privateResult.errors.join(" ")).toMatch(/ikke offentligt|beskyttet/iu);
    }
  });

  it("drops non-allowlisted private records and rendered CSS/script/contact noise", async () => {
    const pages = await pagesFixture();
    pages.push({
      id: 999,
      status: "private",
      title: { rendered: "Hemmelig aktivitet" },
      content: { rendered: "Hemmelig privat tekst", protected: true },
    });
    const parsed = parseAhopPages(pages, RETRIEVED_AT);
    const serialized = JSON.stringify(parsed);

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(7);
    expect(parsed.warnings.join(" ")).toContain("ikke-allowlistet");
    expect(serialized).not.toContain("Hemmelig");
    expect(serialized).not.toContain("Privat Kontakt");
    expect(serialized).not.toContain("12 34 56 78");
    expect(serialized).not.toContain("privateNote");
    expect(serialized).not.toContain("søndage fra 03-04");
  });
});
