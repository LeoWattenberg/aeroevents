import { describe, expect, it } from "vitest";

import {
  dnDetailUrl,
  dnEventsSource,
  dnSearchPageUrl,
  parseDnEvent,
  parseDnSearchPage,
} from "../../scripts/sources/dn-events";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Danmarks Naturfredningsforening source", () => {
  it("validates search pagination without trusting the broken hasNextPage flag", async () => {
    const first = parseDnSearchPage(JSON.parse(await fixture("dn-search-page-1.json")), 0);
    const last = parseDnSearchPage(JSON.parse(await fixture("dn-search-page-2.json")), 1);

    expect(first.errors).toEqual([]);
    expect(first.page).toMatchObject({ totalPages: 2, totalItems: 2, itemIds: ["8067"] });
    expect(last.errors).toEqual([]);
    expect(last.warnings).toContain("DN markerede sidste side med hasNextPage; totalPages blev anvendt");
  });

  it("keeps source IDs stable while parsing location, registration, price, and status", async () => {
    const publicEvent = JSON.parse(await fixture("dn-detail-public.json"));
    const parsed = parseDnEvent(publicEvent, NOW.toISOString());
    const moved = parseDnEvent(
      { ...publicEvent, start: "2026-10-09T17:00:00Z", end: "2026-10-09T19:30:00Z" },
      NOW.toISOString(),
    );
    const cancelled = parseDnEvent(
      JSON.parse(await fixture("dn-detail-cancelled.json")),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidate).toMatchObject({
      stableId: "dn-aeroe-8067",
      title: "Svampetur på Ærø",
      price: "40 kr.",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://billet.example/dn-8067",
      location: {
        name: "Mødested ved skovens p-plads",
        address: "Skovvejen 4",
        postalCode: "5970",
        city: "Ærøskøbing",
      },
      occurrences: [{ date: "2026-10-08", startTime: "19:00", endTime: "21:30" }],
      provenance: { sourceModifiedAt: "2026-08-20T11:12:13.000Z" },
    });
    expect(moved.candidate?.stableId).toBe(parsed.candidate?.stableId);
    expect(parseDnEvent({ ...publicEvent, occupied: true }, NOW.toISOString()).candidate).toMatchObject({
      availability: "sold-out",
    });
    expect(cancelled.candidate).toMatchObject({
      stableId: "dn-aeroe-7495",
      status: "cancelled",
      price: "Gratis",
      location: { name: "Voderup Klint" },
    });
    expect(cancelled.candidate?.location).not.toHaveProperty("address");
  });

  it("refuses private events and events outside the pinned municipality", async () => {
    const detail = JSON.parse(await fixture("dn-detail-public.json"));
    const privateEvent = parseDnEvent({ ...detail, private: true }, NOW.toISOString());
    const wrongMunicipality = parseDnEvent(
      { ...detail, address: { ...detail.address, municipalityCode: "0461" } },
      NOW.toISOString(),
    );

    expect(privateEvent.excluded).toBe(true);
    expect(privateEvent.candidate).toBeUndefined();
    expect(wrongMunicipality.errors).not.toEqual([]);
    expect(wrongMunicipality.candidate).toBeUndefined();
  });

  it("walks every declared search page and detail before returning a complete snapshot", async () => {
    const responses: Record<string, string> = {
      [dnSearchPageUrl(0)]: await fixture("dn-search-page-1.json"),
      [dnSearchPageUrl(1)]: await fixture("dn-search-page-2.json"),
      [dnDetailUrl("8067")]: await fixture("dn-detail-public.json"),
      [dnDetailUrl("7495")]: await fixture("dn-detail-cancelled.json"),
    };
    const result = await dnEventsSource.collect({
      now: NOW,
      fetch: async (input) => {
        const body = responses[String(input)];
        return body ? jsonResponse(body) : jsonResponse("{}", 404);
      },
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(4);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual(["8067", "7495"]);
  });

  it("atomically discards candidates if a required detail fails", async () => {
    const responses: Record<string, string> = {
      [dnSearchPageUrl(0)]: await fixture("dn-search-page-1.json"),
      [dnSearchPageUrl(1)]: await fixture("dn-search-page-2.json"),
      [dnDetailUrl("8067")]: await fixture("dn-detail-public.json"),
    };
    const result = await dnEventsSource.collect({
      now: NOW,
      fetch: async (input) => {
        const body = responses[String(input)];
        return body ? jsonResponse(body) : jsonResponse("upstream failed", 503);
      },
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(1);
  });
});
