import { describe, expect, it } from "vitest";

import {
  folkeuniversitetSource,
  parseFolkeuniversitetDetail,
  parseFolkeuniversitetListing,
} from "../../scripts/sources/folkeuniversitet";
import { sourceDraftToEvent } from "../../scripts/cli/model";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const LISTING = "https://fuko.dk/komite/aeroe-folkeuniversitet/";
const DETAIL_1 = "https://fuko.dk/kurser/robotter-i-hjemmet/";
const DETAIL_2 = "https://fuko.dk/kurser/landbrugets-udfordringer/";

describe("Ærø Folkeuniversitet source", () => {
  it("ignores the historical archive and collects canonical course details", async () => {
    const listingHtml = await fixture("folkeuniversitet-list.html");
    expect(parseFolkeuniversitetListing(listingHtml).items).toHaveLength(2);

    const result = await folkeuniversitetSource.collect({
      fetch: mappedFetch({
        [LISTING]: listingHtml,
        [DETAIL_1]: await fixture("folkeuniversitet-detail-cancelled.html"),
        [DETAIL_2]: await fixture("folkeuniversitet-detail.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(3);
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeroe-folkeuniversitet-robotter-i-hjemmet",
      status: "cancelled",
      attendance: "public",
      price: "100 kr. for voksne, skoleelever har gratis adgang.",
      occurrences: [{ date: "2026-09-07", startTime: "19:00" }],
      provenance: { sourceModifiedAt: "2026-09-06T21:00:32.000Z" },
    });
    expect(result.candidates[1]).toMatchObject({
      stableId: "aeroe-folkeuniversitet-landbrugets-udfordringer",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://booking.example/landbrug",
      location: { name: "Rådhuset", address: "Statene", city: "Ærøskøbing" },
    });
    for (const candidate of result.candidates) expect(() => sourceDraftToEvent(candidate)).not.toThrow();
  });

  it("routes the source's Afholdt label to review because completed is not modeled", async () => {
    const parsed = parseFolkeuniversitetDetail(
      await fixture("folkeuniversitet-detail-cancelled.html"),
      DETAIL_1,
      NOW.toISOString(),
      { statusLabel: "Afholdt" },
    );
    expect(parsed.candidate).toMatchObject({ status: "scheduled", publication: "review" });
    expect(parsed.candidate!.reviewReasons.join(" ")).toContain("afsluttet-status");
  });

  it("never publishes a partial detail set", async () => {
    const result = await folkeuniversitetSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("folkeuniversitet-list.html"),
        [DETAIL_1]: await fixture("folkeuniversitet-detail-cancelled.html"),
        [DETAIL_2]: { status: 500 },
      }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
