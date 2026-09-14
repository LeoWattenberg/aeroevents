import { describe, expect, it } from "vitest";

import {
  marstalMarineforeningSource,
  parseMarstalMarineforeningPage,
} from "../../scripts/sources/marstal-marineforening";
import { fixture, mappedFetch } from "./test-helpers";

const SOURCE_URL = "https://www.marstalmarineforening.dk/aktiviteter/";
const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

describe("Marstal Marineforening source", () => {
  it("emits a bounded Sunday rule and conservatively parsed local one-offs", async () => {
    const result = await marstalMarineforeningSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: await fixture("marstal-marineforening.html"),
      }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(1);
    expect(
      result.candidates.map((candidate) => candidate.sourceEventId),
    ).toEqual([
      "sunday-open-house-2026",
      "afteraarsfest-2026",
      "julemarked-2026",
      "julefrokost-2026",
      "danmarks-befrielse-2027",
      "sendemandsmoede-2027",
    ]);
    expect(result.candidates[0]).toMatchObject({
      sourceId: "marstal-marineforening",
      sourceEventId: "sunday-open-house-2026",
      stableId: "marstal-marineforening-sunday-open-house-2026",
      title: "Søndagsåbent i Marstal Marineforening",
      organizerId: "marstal-marineforening",
      categoryIds: ["forening-faellesskab"],
      location: {
        name: "Marstal Marineforenings Hus",
        address: "Strandstræde 47A",
        postalCode: "5960",
        city: "Marstal",
      },
      attendance: "members",
      publication: "review",
      occurrences: [],
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2000-01-02", startTime: "10:00" },
        startDateUnknown: true,
        rrule: "FREQ=WEEKLY;BYDAY=SU;UNTIL=20261213T100000",
        durationMinutes: 180,
      },
      provenance: {
        sourceUrl: SOURCE_URL,
        retrievedAt: RETRIEVED_AT,
      },
    });
    expect(
      result.candidates.find(
        (candidate) => candidate.sourceEventId === "afteraarsfest-2026",
      ),
    ).toMatchObject({
      attendance: "members",
      price: "180 kr. pr. person",
      bookingRequired: true,
      occurrences: [{ date: "2026-10-02", startTime: "18:30" }],
    });
    expect(
      result.candidates.find(
        (candidate) => candidate.sourceEventId === "julemarked-2026",
      ),
    ).toMatchObject({
      attendance: "unknown",
      occurrences: [
        { date: "2026-11-14", startTime: "10:00", endTime: "16:00" },
      ],
    });
    expect(
      result.candidates.find(
        (candidate) => candidate.sourceEventId === "julefrokost-2026",
      ),
    ).toMatchObject({
      attendance: "unknown",
      occurrences: [{ date: "2026-11-28", startTime: "13:30" }],
    });
    expect(
      result.candidates.find(
        (candidate) => candidate.sourceEventId === "danmarks-befrielse-2027",
      ),
    ).toMatchObject({
      occurrences: [{ date: "2027-05-05", startTime: "09:00" }],
    });
    expect(
      result.candidates.find(
        (candidate) => candidate.sourceEventId === "sendemandsmoede-2027",
      ),
    ).toMatchObject({
      attendance: "unknown",
      occurrences: [
        { date: "2027-05-21", timeUnknown: true },
        { date: "2027-05-22", timeUnknown: true },
        { date: "2027-05-23", timeUnknown: true },
      ],
    });

    if (result.status === "complete") {
      expect(result.snapshotCoverage).toBe("authoritative");
      expect(result.excludedSourceEventIds).toEqual([
        "generalforsamling-2027",
        "klipfiskespisning-2027",
        "pudsedag-2027",
        "sommerfest-2027",
        "tordenskjolds-bakke",
        "tur-til-skagen-2026",
      ]);
    }
    expect(result.warnings.join(" ")).toContain("uden for Ærø");
    expect(result.warnings.join(" ")).toContain("synlige aktivitetsblok");
    expect(JSON.stringify(result.candidates)).not.toMatch(
      /@|telefon|mobil|kontonummer/iu,
    );
  });

  it("emits the unbounded Monday rule only when its exact time is visible in the section", async () => {
    const html = (await fixture("marstal-marineforening.html")).replace(
      "Tordenskjolds bakke består af en gruppe medlemmer",
      "Hver mandag formiddag er der nogen i huset fra 09:30 - 12:00. Tordenskjolds bakke består af en gruppe medlemmer",
    );
    const parsed = parseMarstalMarineforeningPage(html, RETRIEVED_AT, NOW);
    const candidate = parsed.candidates.find(
      (value) => value.sourceEventId === "tordenskjolds-bakke",
    );

    expect(parsed.errors).toEqual([]);
    expect(candidate).toMatchObject({
      stableId: "marstal-marineforening-tordenskjolds-bakke",
      attendance: "members",
      publication: "review",
      occurrences: [],
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2000-01-03", startTime: "09:30" },
        startDateUnknown: true,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        durationMinutes: 150,
      },
    });
    expect(parsed.excludedSourceEventIds).not.toContain("tordenskjolds-bakke");
  });

  it("keeps structural identities when dated details move", async () => {
    const html = await fixture("marstal-marineforening.html");
    const original = parseMarstalMarineforeningPage(html, RETRIEVED_AT, NOW);
    const moved = parseMarstalMarineforeningPage(
      html
        .replace("fredag den 2. oktober", "fredag den 9. oktober")
        .replace("søndag den 13. december", "søndag den 20. december"),
      RETRIEVED_AT,
      NOW,
    );
    const originalParty = original.candidates.find(
      (candidate) => candidate.sourceEventId === "afteraarsfest-2026",
    );
    const movedParty = moved.candidates.find(
      (candidate) => candidate.sourceEventId === "afteraarsfest-2026",
    );

    expect(moved.errors).toEqual([]);
    expect(movedParty?.stableId).toBe(originalParty?.stableId);
    expect(movedParty?.occurrences[0]).toMatchObject({
      id: originalParty?.occurrences[0]?.id,
      date: "2026-10-09",
    });
    expect(moved.candidates[0]?.stableId).toBe(
      original.candidates[0]?.stableId,
    );
    expect(moved.candidates[0]?.schedule?.rrule).toContain(
      "UNTIL=20261220T100000",
    );
  });

  it("atomically rejects malformed dates and duplicate structural headings", async () => {
    const html = await fixture("marstal-marineforening.html");
    const malformed = await marstalMarineforeningSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace("14. november 2026", "31. november 2026"),
      }),
      now: NOW,
    });
    const duplicated = await marstalMarineforeningSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace(
          "          <p>\n            Tordenskjolds bakke består",
          "          <p><strong>Tordenskjolds bakke</strong></p>\n          <p>\n            Tordenskjolds bakke består",
        ),
      }),
      now: NOW,
    });

    expect(malformed.status).toBe("partial");
    expect(malformed.candidates).toEqual([]);
    expect(malformed.errors.join(" ")).toContain("Julemarked");
    expect(duplicated.status).toBe("partial");
    expect(duplicated.candidates).toEqual([]);
    expect(duplicated.errors.join(" ")).toContain(
      "Tordenskjolds bakke flere gange",
    );
  });

  it("fails closed on a new undated bold activity heading", async () => {
    const html = (await fixture("marstal-marineforening.html")).replace(
      '<p><span style="font-weight: bold; font-size: 24px">2027</span></p>',
      '<p><span style="font-weight: bold; font-size: 20px">Ny klubaften</span></p><p>Detaljer følger.</p><p><span style="font-weight: bold; font-size: 24px">2027</span></p>',
    );
    const parsed = await marstalMarineforeningSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: html }),
      now: NOW,
    });

    expect(parsed.status).toBe("partial");
    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors.join(" ")).toContain(
      "ukendt fremhævet overskrift: Ny klubaften",
    );
  });

  it("fails closed on canonical, page-identity, and size drift", async () => {
    const html = await fixture("marstal-marineforening.html");
    const unsafeCanonical = parseMarstalMarineforeningPage(
      html.replace(
        "https://marstalmarineforening.dk/aktiviteter/",
        "https://example.com/aktiviteter/",
      ),
      RETRIEVED_AT,
      NOW,
    );
    const wrongPage = parseMarstalMarineforeningPage(
      html.replace("2674142B-D3C9-4DFC-9AAE-E2905B6EF6C8", "WRONG-PAGE"),
      RETRIEVED_AT,
      NOW,
    );
    const tooManyParagraphs = parseMarstalMarineforeningPage(
      html.replace(
        "</div>\n      </div>\n    </div>",
        `${"<p>Fyld</p>".repeat(201)}</div>\n      </div>\n    </div>`,
      ),
      RETRIEVED_AT,
      NOW,
    );

    expect(unsafeCanonical.errors.join(" ")).toContain("canonical-link");
    expect(wrongPage.errors.join(" ")).toContain("sideidentitet");
    expect(tooManyParagraphs.errors.join(" ")).toContain("1-200 afsnit");
  });

  it("reports transport failures without replacing a snapshot", async () => {
    const result = await marstalMarineforeningSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: { status: 503, body: "unavailable" },
      }),
      now: NOW,
    });

    expect(result.status).toBe("failed");
    expect(result.pagesFetched).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("HTTP 503");
  });
});
