import { describe, expect, it } from "vitest";

import {
  aeldresagenSource,
  parseAeldresagenListing,
} from "../../scripts/sources/aeldresagen";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const LISTING = "https://www.aeldresagen.dk/lokalafdelinger/aeroe/aktiviteter-og-kurser?sortering=dato";
const DETAIL_1 = "https://www.aeldresagen.dk/aktiviteter-og-kurser/kommune/aeroe/aeroe/443497864-foredrag";
const DETAIL_2 = "https://www.aeldresagen.dk/aktiviteter-og-kurser/kommune/aeroe/aeroe/443478288-gaature";

describe("Ældre Sagen Ærø source", () => {
  it("checks the declared count and collects one-off and recurring activity details", async () => {
    const result = await aeldresagenSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("aeldresagen-list.html"),
        [DETAIL_1]: await fixture("aeldresagen-detail-once.html"),
        [DETAIL_2]: await fixture("aeldresagen-detail-recurring.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(3);
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeldresagen-aeroe-443497864",
      attendance: "registration",
      attendanceDetails: "For alle",
      price: "Pris: Medlemmer 75 kr. Ikke-medlemmer 125 kr.",
      bookingRequired: true,
      bookingUrl: "https://booking.example/foredrag",
      occurrences: [{ date: "2026-10-28", startTime: "15:00", endTime: "17:00" }],
    });
    expect(result.candidates[1]).toMatchObject({
      stableId: "aeldresagen-aeroe-443478288",
      publication: "review",
      occurrences: [{ date: "2026-09-21", startTime: "10:00", endTime: "11:00" }],
    });
    expect(result.candidates[1]!.reviewReasons.join(" ")).toContain("gentagelse");
  });

  it("stops at the listing when the declared count and HTML disagree", async () => {
    const listing = (await fixture("aeldresagen-list.html")).replace(">2<", ">3<");
    const requested: string[] = [];
    const result = await aeldresagenSource.collect({
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(listing, { headers: { "content-type": "text/html" } });
      },
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(requested).toEqual([LISTING]);
    expect(result.errors.join(" ")).toContain("3 resultater");
  });

  it("rejects activity links outside the official HTTPS origin", async () => {
    const html = (await fixture("aeldresagen-list.html")).replace(DETAIL_1.replace("https://www.aeldresagen.dk", ""), "https://attacker.example/443497864-foredrag");
    expect(parseAeldresagenListing(html).errors.join(" ")).toContain("usikkert link");
  });
});
