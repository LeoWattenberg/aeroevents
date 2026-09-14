import { describe, expect, it } from "vitest";

import {
  marstalBillardKlubSource,
  parseMarstalBillardKlubPage,
} from "../../scripts/sources/marstal-billard-klub";
import { fixture, mappedFetch } from "./test-helpers";

const SOURCE_URL = "https://spiller.ddbu-admin.dk/?m=1005&klubnr=511";
const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

describe("Marstal Billard Klub DDBU source", () => {
  it("emits only future home games and excludes away games and blank-opponent byes", async () => {
    const result = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: await fixture("marstal-billard-klub.html") }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(1);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "242475",
      "231356",
    ]);
    expect(result.warnings.join(" ")).toContain("historisk kamp");
    expect(result.warnings.join(" ")).toContain("udekamp");
    expect(result.warnings.join(" ")).toContain("2 frirunder");
    expect(result.candidates[0]).toMatchObject({
      sourceId: "marstal-billard-klub",
      sourceEventId: "242475",
      stableId: "marstal-billard-klub-242475",
      title: "Marstal BK – Sydfyn BK",
      description: "Keglebillard - Serie 1 Vest",
      organizerId: "marstal-billard-klub",
      categoryIds: ["sport-motion", "forening-faellesskab"],
      location: {
        name: "Marstal Billard Klub",
        address: "Tordenskjoldsgade 20, 1.",
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [{
        id: "ddbu-242475",
        date: "2026-10-07",
        allDay: false,
        timeUnknown: true,
      }],
      status: "scheduled",
      attendance: "unknown",
      publication: "review",
      provenance: {
        externalId: "242475",
        sourceUrl: "https://www.ddbu-admin.dk/external/hold_kamp_res.php?kampid=242475",
        retrievedAt: RETRIEVED_AT,
      },
    });
    expect(result.candidates[0]?.occurrences[0]).not.toHaveProperty("startTime");
    expect(result.candidates[0]?.reviewReasons.join(" ")).toContain("starttid");
    expect(JSON.stringify(result.candidates)).not.toContain("Fiktiv privatperson");
    if (result.status === "complete") {
      expect(result.excludedSourceEventIds).toEqual(["231353", "242469", "242474", "242483"]);
    }
  });

  it("keeps the numeric match identity when DDBU moves the date", async () => {
    const html = await fixture("marstal-billard-klub.html");
    const original = parseMarstalBillardKlubPage(html, RETRIEVED_AT, NOW)
      .candidates.find((candidate) => candidate.sourceEventId === "242475");
    const moved = parseMarstalBillardKlubPage(
      html.replace("07-10-2026", "14-10-2026"),
      RETRIEVED_AT,
      NOW,
    ).candidates.find((candidate) => candidate.sourceEventId === "242475");

    expect(original).toBeDefined();
    expect(moved).toMatchObject({
      sourceEventId: original?.sourceEventId,
      stableId: original?.stableId,
      occurrences: [{ id: "ddbu-242475", date: "2026-10-14", timeUnknown: true }],
    });
  });

  it("atomically rejects a malformed match row", async () => {
    const html = (await fixture("marstal-billard-klub.html")).replace(
      "07-10-2026",
      "31-02-2026",
    );
    const result = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: html }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("gyldig eksplicit dato");
    if (result.status === "partial") expect(result.discardedCandidateCount).toBe(1);
  });

  it("atomically rejects an unsafe or mismatched match detail link", async () => {
    const unsafe = (await fixture("marstal-billard-klub.html")).replace(
      "<td>242475</td>",
      '<td><a href="https://evil.example/external/hold_kamp_res.php?kampid=242475">242475</a></td>',
    );
    const mismatched = (await fixture("marstal-billard-klub.html")).replace(
      "<td>242475</td>",
      '<td><a href="https://www.ddbu-admin.dk/external/hold_kamp_res.php?kampid=999999">242475</a></td>',
    );

    for (const html of [unsafe, mismatched]) {
      const result = await marstalBillardKlubSource.collect({
        fetch: mappedFetch({ [SOURCE_URL]: html }),
        now: NOW,
      });
      expect(result.status).toBe("partial");
      expect(result.candidates).toEqual([]);
      expect(result.errors.join(" ")).toMatch(/detaljelink/iu);
    }
  });

  it("atomically rejects duplicate numeric match identities", async () => {
    const html = (await fixture("marstal-billard-klub.html")).replace(
      "<td>231356</td>",
      "<td>242475</td>",
    );
    const result = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: html }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("242475 flere gange");
  });

  it("atomically rejects source fields that exceed the public model's bounds", async () => {
    const html = await fixture("marstal-billard-klub.html");
    const oversizedId = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace("<td>242475</td>", `<td>${"9".repeat(21)}</td>`),
      }),
      now: NOW,
    });
    const oversizedTeam = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace("<td>Sydfyn BK</td>", `<td>${"A".repeat(111)}</td>`),
      }),
      now: NOW,
    });

    expect(oversizedId.status).toBe("partial");
    expect(oversizedId.candidates).toEqual([]);
    expect(oversizedId.errors.join(" ")).toContain("stabilt numerisk kamp-id");
    expect(oversizedTeam.status).toBe("partial");
    expect(oversizedTeam.candidates).toEqual([]);
    expect(oversizedTeam.errors.join(" ")).toContain("for langt holdnavn");
  });

  it("returns partial rather than replacing a snapshot when no future home game remains", async () => {
    const result = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: await fixture("marstal-billard-klub.html") }),
      now: new Date("2027-12-01T10:00:00.000Z"),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("ingen fremtidige hjemmekampe");
    if (result.status === "partial") expect(result.discardedCandidateCount).toBe(0);
  });

  it("rejects a table that is not consistently scoped to Marstal Billard Klub", async () => {
    const html = (await fixture("marstal-billard-klub.html")).replace(
      "<td>Otterup BK</td>",
      "<td>Haarby BK</td>",
    ).replace(
      "<td>Marstal BK</td>\n          <td>1</td>\n        </tr>\n        <tr>\n          <td>07-10-2026</td>",
      "<td>Sydfyn BK</td>\n          <td>1</td>\n        </tr>\n        <tr>\n          <td>07-10-2026</td>",
    );
    const result = await marstalBillardKlubSource.collect({
      fetch: mappedFetch({ [SOURCE_URL]: html }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("tilhører ikke entydigt Marstal Billard Klub");
  });
});
