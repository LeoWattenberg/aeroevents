import { describe, expect, it } from "vitest";

import {
  kunsthoejskolenSource,
  parseKunsthoejskolenDetail,
  parseKunsthoejskolenListing,
} from "../../scripts/sources/kunsthoejskolen";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const LISTING = "https://www.kunstaeroe.dk/for-og-efter%C3%A5rskurser";
const AVAILABLE = "https://www.kunstaeroe.dk/maleri-farvens-kraft";
const SOLD_OUT = "https://www.kunstaeroe.dk/keramik-form-og-ild";

describe("Kunsthøjskolen på Ærø source", () => {
  it("uses Cargo page IDs and keeps dates, price, booking, and sold-out state", async () => {
    const listingHtml = await fixture("kunsthoejskolen-list.html");
    const listing = parseKunsthoejskolenListing(listingHtml, LISTING, NOW);
    expect(listing.errors).toEqual([]);
    expect(listing.items).toHaveLength(2);

    const result = await kunsthoejskolenSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [LISTING]: listingHtml,
        [AVAILABLE]: await fixture("kunsthoejskolen-detail-available.html"),
        [SOLD_OUT]: await fixture("kunsthoejskolen-detail-soldout.html"),
      }),
    });
    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(3);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sourceEventId: "Z3446798542",
      stableId: "kunsthoejskolen-aeroe-Z3446798542",
      title: "MALERI: Farvens kraft",
      price: "Pris kr. 5.491,-",
      bookingRequired: true,
      bookingUrl: "https://www.webtilmeldinger.dk/TilmeldingsFormularV2/Tilmelding.aspx?FormId={ABC}",
      availability: "available",
      publication: "trusted",
      occurrences: [{ date: "2026-10-04", endDate: "2026-10-10", allDay: true }],
    });
    expect(result.candidates[1]).toMatchObject({
      sourceEventId: "O3785155640",
      availability: "sold-out",
      publication: "trusted",
    });
  });

  it("rejects a detail page whose stable Cargo identity does not match the requested page", async () => {
    const expected = parseKunsthoejskolenListing(
      await fixture("kunsthoejskolen-list.html"), LISTING, NOW,
    ).items[0]!;
    const html = (await fixture("kunsthoejskolen-detail-available.html"))
      .replace('"purl":"maleri-farvens-kraft"', '"purl":"et-andet-kursus"');
    const parsed = parseKunsthoejskolenDetail(html, AVAILABLE, expected, NOW.toISOString());
    expect(parsed.candidate).toBeUndefined();
    expect(parsed.errors.join(" ")).toContain("matcher ikke");
  });

  it("never returns a partial set when one required detail fails", async () => {
    const result = await kunsthoejskolenSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [LISTING]: await fixture("kunsthoejskolen-list.html"),
        [AVAILABLE]: await fixture("kunsthoejskolen-detail-available.html"),
        [SOLD_OUT]: { status: 500 },
      }),
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    if (result.status !== "partial") throw new Error("Forventede et delvist resultat");
    expect(result.discardedCandidateCount).toBe(1);
  });
});
