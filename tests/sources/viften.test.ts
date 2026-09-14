import { describe, expect, it } from "vitest";

import { parseViftenDetail, viftenSource } from "../../scripts/sources/viften";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const LISTING = "https://www.viften.net/ture";
const DETAIL = "https://www.viften.net/subjectclass/29c4da51dbc547608099eb011d23c72e";

describe("Viften source", () => {
  it("collects date, age restriction, price, deadline, and enrollment state", async () => {
    const result = await viftenSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("viften-list.html"),
        [DETAIL]: await fixture("viften-detail.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(result.candidates[0]).toMatchObject({
      stableId: "viften-29c4da51dbc547608099eb011d23c72e",
      price: "200 kr.",
      attendance: "registration",
      attendanceDetails: "For alle børn og unge på Ærø i 4. - 10. klasse",
      bookingRequired: true,
      bookingDetails: "Tilmeldingsfrist 14. september 2026 kl. 23.59",
      availability: "available",
      location: { city: "Ærøskøbing" },
      occurrences: [{ date: "2026-09-26", startTime: "08:00", endTime: "17:15" }],
      publication: "review",
    });
    expect(result.candidates[0]!.reviewReasons.join(" ")).toContain("årstal");
  });

  it("keeps the GUID stable when an event date changes", async () => {
    const html = await fixture("viften-detail.html");
    const original = parseViftenDetail(html, DETAIL, NOW.toISOString()).candidate!;
    const changed = parseViftenDetail(
      html.replace("26/9", "27/9"),
      DETAIL,
      NOW.toISOString(),
    ).candidate!;
    expect(changed.stableId).toBe(original.stableId);
    expect(changed.occurrences[0]!.id).toBe(original.occurrences[0]!.id);
    expect(changed.occurrences[0]!.date).toBe("2026-09-27");
  });

  it("keeps the prior snapshot when a detail request fails", async () => {
    const result = await viftenSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("viften-list.html"),
        [DETAIL]: { status: 503 },
      }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
