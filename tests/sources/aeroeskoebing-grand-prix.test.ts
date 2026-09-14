import { describe, expect, it } from "vitest";

import {
  aeroeskoebingGrandPrixSource,
  parseAeroeskoebingGrandPrixPage,
} from "../../scripts/sources/aeroeskoebing-grand-prix";
import { fixture, mappedFetch } from "./test-helpers";

const URL = "https://www.xn--rgrandprix-c6a1t.dk/";
const NOW = new Date("2026-09-14T10:00:00.000Z");

describe("Ærøskøbing Grand Prix source", () => {
  it("expands the content-derived 2026 range into four explicit activity days", async () => {
    const parsed = parseAeroeskoebingGrandPrixPage(
      await fixture("aeroeskoebing-grand-prix.html"),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidate).toMatchObject({
      sourceEventId: "aeroeskoebing-grand-prix-2026",
      stableId: "aeroeskoebing-grand-prix-2026",
      title: "Ærøskøbing Grand Prix 2026",
      status: "scheduled",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://www.xn--rgrandprix-c6a1t.dk/tilmelding",
      publication: "review",
      location: { city: "Ærøskøbing" },
      provenance: { sourceUrl: URL },
    });
    expect(parsed.candidate!.occurrences).toEqual([
      expect.objectContaining({ id: "aeroeskoebing-grand-prix-2026-10-12", date: "2026-10-12", startTime: "09:00", endTime: "12:00" }),
      expect.objectContaining({ id: "aeroeskoebing-grand-prix-2026-10-13", date: "2026-10-13", startTime: "09:00", endTime: "12:00" }),
      expect.objectContaining({ id: "aeroeskoebing-grand-prix-2026-10-14", date: "2026-10-14", startTime: "09:00", endTime: "12:00" }),
      expect.objectContaining({ id: "aeroeskoebing-grand-prix-2026-10-15", date: "2026-10-15", startTime: "09:00", endTime: "12:00" }),
    ]);
    expect(parsed.candidate!.reviewReasons.join(" ")).toContain("uden et selvstændigt eventobjekt");
  });

  it("derives changed activity days from the Wix text instead of hardcoding them", async () => {
    const html = (await fixture("aeroeskoebing-grand-prix.html")).replace(
      "andag d 12. okt til torsdag d 15. okt",
      "andag d 19. okt til onsdag d 21. okt",
    );
    const parsed = parseAeroeskoebingGrandPrixPage(html, NOW.toISOString());
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidate!.occurrences.map((occurrence) => occurrence.date)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  it("does not turn unrelated year text into additional events", async () => {
    const parsed = parseAeroeskoebingGrandPrixPage(
      await fixture("aeroeskoebing-grand-prix.html"),
      NOW.toISOString(),
    );
    expect(parsed.candidate!.occurrences).toHaveLength(4);
    expect(parsed.candidate!.description).not.toContain("grundlagt");
  });

  it("returns an atomic partial result for a malformed schedule block", async () => {
    const html = (await fixture("aeroeskoebing-grand-prix.html")).replace(
      "09.00-12.00",
      "09.00-xx",
    );
    const result = await aeroeskoebingGrandPrixSource.collect({
      fetch: mappedFetch({ [URL]: html }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("start- og sluttidspunkt");
  });

  it("rejects an unexpected canonical host before producing a candidate", async () => {
    const html = (await fixture("aeroeskoebing-grand-prix.html")).replace(
      "https://www.xn--rgrandprix-c6a1t.dk\">",
      "https://example.invalid\">",
    );
    const parsed = parseAeroeskoebingGrandPrixPage(html, NOW.toISOString());
    expect(parsed.candidate).toBeUndefined();
    expect(parsed.errors.join(" ")).toContain("canonical");
  });
});
