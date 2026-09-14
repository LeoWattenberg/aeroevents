import { describe, expect, it } from "vitest";

import {
  aeroeGolfklubSource,
  parseAeroeGolfklubPage,
} from "../../scripts/sources/aeroe-golfklub";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const SOURCE_URL = "https://www.aeroegolf.dk/turneringer.aspx";

describe("Ærø Golf Klub source", () => {
  it("parses open and member tournaments with bounded date ranges", async () => {
    const parsed = parseAeroeGolfklubPage(
      await fixture("aeroe-golfklub.html"),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.declaredYear).toBe(2026);
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.candidates[0]).toMatchObject({
      sourceEventId: "2026-aeroe-open-by-stark-stableford",
      title: "ÆRØ OPEN by STARK – Stableford",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://golfbox.golf/#/",
      publication: "review",
      occurrences: [{ date: "2026-08-22", timeUnknown: true }],
    });
    expect(parsed.candidates[1]).toMatchObject({
      attendance: "members",
      occurrences: [
        { date: "2026-09-05", timeUnknown: true },
        { date: "2026-09-06", timeUnknown: true },
      ],
    });
    expect(parsed.candidates[2]).toMatchObject({
      sourceEventId: "2026-superbrugsen-afslutningsturnering-stableford",
      occurrences: [{ date: "2026-10-04" }],
      location: {
        name: "Ærø Golf Klub",
        address: "Skjoldnæsvej 8",
        postalCode: "5985",
      },
    });
  });

  it("keeps title-based identity when a date moves", async () => {
    const html = await fixture("aeroe-golfklub.html");
    const original = parseAeroeGolfklubPage(html, NOW.toISOString()).candidates[2]!;
    const moved = parseAeroeGolfklubPage(
      html.replace("Søndag 4/10:", "Søndag 11/10:"),
      NOW.toISOString(),
    ).candidates[2]!;

    expect(moved.sourceEventId).toBe(original.sourceEventId);
    expect(moved.stableId).toBe(original.stableId);
    expect(moved.occurrences[0]!.id).toBe(original.occurrences[0]!.id);
    expect(moved.occurrences[0]!.date).toBe("2026-10-11");
  });

  it("returns only future occurrences during collection", async () => {
    const result = await aeroeGolfklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: await fixture("aeroe-golfklub.html") }),
    });

    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.sourceEventId).toContain("afslutningsturnering");
  });

  it("atomically rejects invalid ranges and duplicate identities", async () => {
    const html = await fixture("aeroe-golfklub.html");
    const invalid = parseAeroeGolfklubPage(
      html.replace("5-6/9", "8-2/9"),
      NOW.toISOString(),
    );
    const duplicate = await aeroeGolfklubSource.collect({
      now: new Date("2026-08-01T10:00:00.000Z"),
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace(
          "SuperBrugsen Afslutningsturnering – Stableford",
          "ÆRØ OPEN by STARK – Stableford",
        ),
      }),
    });

    expect(invalid.errors.join(" ")).toContain("ugyldigt datointerval");
    expect(duplicate.status).toBe("partial");
    expect(duplicate.candidates).toEqual([]);
    expect(duplicate.errors.join(" ")).toContain("dublerede turneringstitler");
  });

  it("fails closed when a dated calendar line changes to an unknown format", async () => {
    const html = (await fixture("aeroe-golfklub.html")).replace(
      "Søndag 4/10:",
      "Søndag den 4/10:",
    );
    const result = await aeroeGolfklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: html }),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("dateret linje i et ukendt format");
  });
});
