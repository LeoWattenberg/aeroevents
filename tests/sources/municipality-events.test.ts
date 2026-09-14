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

  it("trusts the municipality publication year when the visible date omits it", async () => {
    const html = (await fixture("municipality-event-detail.html"))
      .replace(
        '<meta name="description" content="15. september 2026">',
        '<meta name="description" content="Ordinært møde onsdag den 16. september kl. 19.00.">',
      )
      .replace(
        '<meta name="cmspageupdated" content="2026-08-25 09.31">',
        '<meta name="cmspageactiveto" content="2026-09-17 22.00">\n<meta name="cmspageupdated" content="2026-08-25 09.31">',
      )
      .replace("tirsdag 15. september", "onsdag 16. september")
      .replace("Klokken 17.00 - 19.30", "Klokken 19.00 - 21.00");
    const parsed = parseMunicipalityEventDetail(html, DETAIL, NOW.toISOString());

    expect(parsed.candidate).toMatchObject({
      publication: "trusted",
      occurrences: [{ date: "2026-09-16", startTime: "19:00" }],
    });
    expect(parsed.candidate?.reviewReasons).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it("infers a year across an adjacent New Year publication boundary", async () => {
    const html = (await fixture("municipality-event-detail.html"))
      .replace(
        '<meta name="description" content="15. september 2026">',
        '<meta name="description" content="Torsdag den 31. december kl. 17.00.">',
      )
      .replace(
        '<meta name="cmspageupdated" content="2026-08-25 09.31">',
        '<meta name="cmspageactiveto" content="2027-01-01 22.00">\n<meta name="cmspageupdated" content="2026-08-25 09.31">',
      )
      .replace("tirsdag 15. september", "torsdag 31. december");
    const parsed = parseMunicipalityEventDetail(html, DETAIL, NOW.toISOString());

    expect(parsed.candidate).toMatchObject({
      publication: "trusted",
      occurrences: [{ date: "2026-12-31", startTime: "17:00" }],
    });
  });

  it("rejects a year inference when the CMS publication window is not adjacent", async () => {
    const html = (await fixture("municipality-event-detail.html"))
      .replace(
        '<meta name="description" content="15. september 2026">',
        '<meta name="description" content="Tirsdag den 15. september kl. 17.00.">',
      )
      .replace(
        '<meta name="cmspageupdated" content="2026-08-25 09.31">',
        '<meta name="cmspageactiveto" content="2026-10-30 22.00">\n<meta name="cmspageupdated" content="2026-08-25 09.31">',
      );
    const parsed = parseMunicipalityEventDetail(html, DETAIL, NOW.toISOString());

    expect(parsed.candidate).toBeUndefined();
    expect(parsed.errors.join(" ")).toContain("gyldig dato med årstal");
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
