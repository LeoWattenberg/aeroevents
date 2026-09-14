import { describe, expect, it } from "vitest";

import {
  aeldresagenSource,
  parseAeldresagenDetail,
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
      publication: "trusted",
      occurrences: [{ date: "2026-09-21", startTime: "10:00", endTime: "11:00" }],
    });
    expect(result.candidates[1]!.reviewReasons).toEqual([]);
    expect(result.warnings.join(" ")).toContain("næste eksplicitte forekomst");
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

  it("trusts an explicit next occurrence even when no meeting place is supplied", async () => {
    const html = (await fixture("aeldresagen-detail-recurring.html")).replace(
      '<h2>Mødested</h2><p>Det gamle posthus, Havnegade 3, Marstal</p>',
      "",
    );
    const parsed = parseAeldresagenDetail(html, DETAIL_2, NOW.toISOString());

    expect(parsed.candidate).toMatchObject({
      publication: "trusted",
      occurrences: [{ date: "2026-09-21", startTime: "10:00", endTime: "11:00" }],
    });
    expect(parsed.candidate).not.toHaveProperty("location");
    expect(parsed.candidate?.reviewReasons).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("mødested");
  });

  it("does not infer a recurring occurrence without an explicit next date", async () => {
    const html = (await fixture("aeldresagen-detail-recurring.html")).replace(
      /Næste forekomst:<br>Mandag d\. 21\.09\.2026<br>kl\. 10:00 - 11:00/,
      "",
    );
    const parsed = parseAeldresagenDetail(html, DETAIL_2, NOW.toISOString());

    expect(parsed.candidate).toBeUndefined();
    expect(parsed.errors.join(" ")).toContain("gyldig dato");
  });

  it("routes a stale explicit next occurrence to review", async () => {
    const parsed = parseAeldresagenDetail(
      await fixture("aeldresagen-detail-recurring.html"),
      DETAIL_2,
      "2026-09-22T10:00:00.000Z",
    );

    expect(parsed.candidate?.publication).toBe("review");
    expect(parsed.candidate?.reviewReasons.join(" ")).toContain("før indsamlingstidspunktet");
  });

  it("rejects activity links outside the official HTTPS origin", async () => {
    const html = (await fixture("aeldresagen-list.html")).replace(DETAIL_1.replace("https://www.aeldresagen.dk", ""), "https://attacker.example/443497864-foredrag");
    expect(parseAeldresagenListing(html).errors.join(" ")).toContain("usikkert link");
  });
});
