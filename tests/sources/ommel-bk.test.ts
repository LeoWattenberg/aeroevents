import { describe, expect, it } from "vitest";

import {
  dbuHomeMatchProgramUrl,
  ommelBkSource,
  parseDbuClubPools,
  parseDbuMatchProgram,
} from "../../scripts/sources/ommel-bk";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const CLUB_URL = "https://www.dbufyn.dk/resultater/klub/1464/kampprogram";

function extraMatchRow(options: {
  matchId: string;
  date: string;
  home: string;
  away: string;
}): string {
  return `
    <tr class="has-hover" onclick="MatchProgramMatchClick('/resultater/kamp/${options.matchId}_501669/kampinfo')">
      <td></td><td>${options.matchId}</td><td>${options.date}</td><td>12:30</td>
      <td><span>Herrer S4, Efterår 2026 (11:11/9:9)</span><span>Pulje 2</span></td>
      <td><div class="name-logo-remarks"><span>${options.home}</span></div></td>
      <td><div class="name-logo-remarks"><span>${options.away}</span></div></td>
      <td><a href="/resultater/stadium/739">Ommel Stadion</a></td><td></td>
    </tr>`;
}

describe("Ommel BK DBU Fyn source", () => {
  it("discovers current pool rows and derives DBU's query indexes dynamically", async () => {
    const club = (await fixture("ommel-club.html")).replace(
      "</tbody>",
      `<tr><td><label><input class="SRPoolRowCB" value="449999">Kvinder C, Efterår 2026</label></td><td>Pulje 1</td></tr></tbody>`,
    );
    const parsed = parseDbuClubPools(club);

    expect(parsed.errors).toEqual([]);
    expect(parsed.pools).toEqual([
      {
        id: "449338",
        queryIndex: 0,
        competition: "Herrer S4, Efterår 2026 (11:11/9:9)",
        poolName: "Pulje 2",
      },
      {
        id: "449999",
        queryIndex: 1,
        competition: "Kvinder C, Efterår 2026",
        poolName: "Pulje 1",
      },
    ]);
    const url = new URL(dbuHomeMatchProgramUrl(parsed.pools, NOW));
    expect(url.searchParams.get("pools")).toBe("0_1");
    expect(url.searchParams.get("fra")).toBe("14-09-2026");
    expect(url.searchParams.get("til")).toBe("14-09-2027");
    expect(url.searchParams.get("hjemmekampe")).toBe("true");
    expect(url.searchParams.get("udekampe")).toBe("false");
  });

  it("parses stable match and pool IDs, teams, stadium, time, and status", async () => {
    const html = (await fixture("ommel-home-matches.html")).replace(
      '<td class="result-col"></td>',
      '<td class="result-col">Udsat</td>',
    );
    const parsed = parseDbuMatchProgram(html);

    expect(parsed.errors).toEqual([]);
    expect(parsed.matches[0]).toEqual({
      matchId: "633197",
      poolId: "501669",
      date: "2026-09-27",
      time: "13:45",
      competition: "Herrer S4, Efterår 2026 (11:11/9:9)",
      poolName: "Pulje 2",
      homeTeam: "Ommel BK",
      awayTeam: "Skårup IF (3)",
      stadium: "Ommel Stadion",
      stadiumUrl: "https://www.dbufyn.dk/resultater/stadium/739",
      sourceUrl: "https://www.dbufyn.dk/resultater/kamp/633197_501669/kampinfo",
      status: "postponed",
    });
    expect(parsed.matches[1]).toMatchObject({ matchId: "633210", status: "scheduled" });
  });

  it("fetches the discovered selection and emits only future Ommel home matches", async () => {
    const club = await fixture("ommel-club.html");
    const pools = parseDbuClubPools(club).pools;
    const programUrl = dbuHomeMatchProgramUrl(pools, NOW);
    const baseProgram = await fixture("ommel-home-matches.html");
    const program = baseProgram.replace(
      "</tbody>",
      `${extraMatchRow({
        matchId: "600001",
        date: "22-04 2026",
        home: "Ommel BK",
        away: "Haarby IF",
      })}${extraMatchRow({
        matchId: "600002",
        date: "25-10 2026",
        home: "Skårup IF",
        away: "Ommel BK",
      })}</tbody>`,
    );
    const requested: string[] = [];
    const fetch = mappedFetch({ [CLUB_URL]: club, [programUrl]: program });
    const result = await ommelBkSource.collect({
      now: NOW,
      fetch: async (input, init) => {
        requested.push(String(input));
        return fetch(input, init);
      },
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(requested).toEqual([CLUB_URL, programUrl]);
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "633197",
      "633210",
    ]);
    expect(result.candidates[0]).toMatchObject({
      stableId: "ommel-bk-633197",
      title: "Ommel BK – Skårup IF (3)",
      status: "scheduled",
      attendance: "public",
      publication: "trusted",
      location: { name: "Ommel Stadion" },
      occurrences: [{ date: "2026-09-27", startTime: "13:45" }],
    });
    expect(result.warnings.some((warning) => warning.includes("600001"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("600002"))).toBe(true);
  });

  it("rejects an unsafe source link without exposing a partial snapshot", async () => {
    const club = await fixture("ommel-club.html");
    const programUrl = dbuHomeMatchProgramUrl(parseDbuClubPools(club).pools, NOW);
    const program = (await fixture("ommel-home-matches.html")).replace(
      "/resultater/kamp/633197_501669/kampinfo",
      "https://evil.example/resultater/kamp/633197_501669/kampinfo",
    );
    const result = await ommelBkSource.collect({
      now: NOW,
      fetch: mappedFetch({ [CLUB_URL]: club, [programUrl]: program }),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.some((error) => error.includes("usikkert link"))).toBe(true);
  });
});
