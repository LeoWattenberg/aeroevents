import { describe, expect, it } from "vitest";

import {
  municipalityEventsSource,
  parseMunicipalityEventDetail,
  parseMunicipalityEventsListing,
} from "../../scripts/sources/municipality-events";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const LISTING = "https://www.aeroekommune.dk/om-kommunen/kommunikation-og-presse/det-sker";
const DETAIL = `${LISTING}/groen-aften`;

describe("Ærø Kommune Det sker source", () => {
  it("collects authoritative detail data with the pageid as stable identity", async () => {
    const result = await municipalityEventsSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("municipality-events-list.html"),
        [DETAIL]: await fixture("municipality-event-detail.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeroe-kommune-events-3e08a557-3498-49c3-a4f0-c79c0b4d8bb4",
      price: "40 kroner",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://booking.example/groen-aften",
      location: {
        name: "Kulturhuset",
        address: "Vestergade 1",
        postalCode: "5970",
        city: "Ærøskøbing",
      },
      occurrences: [{ date: "2026-09-15", startTime: "17:00", endTime: "19:30" }],
      provenance: { sourceModifiedAt: "2026-08-25T07:31:00.000Z" },
    });
  });

  it("keeps stable event and occurrence IDs when the advertised date changes", async () => {
    const originalHtml = await fixture("municipality-event-detail.html");
    const changedHtml = originalHtml.replaceAll("15. september", "22. september");
    const original = parseMunicipalityEventDetail(originalHtml, DETAIL, NOW.toISOString()).candidate!;
    const changed = parseMunicipalityEventDetail(changedHtml, DETAIL, NOW.toISOString()).candidate!;

    expect(changed.stableId).toBe(original.stableId);
    expect(changed.occurrences[0]!.id).toBe(original.occurrences[0]!.id);
    expect(changed.occurrences[0]!.date).toBe("2026-09-22");
  });

  it("rejects cross-origin detail links and never publishes a partial snapshot", async () => {
    const unsafe = (await fixture("municipality-events-list.html")).replace(
      "/om-kommunen/kommunikation-og-presse/det-sker/groen-aften",
      "https://attacker.example/event",
    );
    expect(parseMunicipalityEventsListing(unsafe).errors).not.toEqual([]);

    const result = await municipalityEventsSource.collect({
      fetch: mappedFetch({
        [LISTING]: await fixture("municipality-events-list.html"),
        [DETAIL]: { status: 500 },
      }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
