import { describe, expect, it } from "vitest";

import {
  aeroeBridgeklubSource,
  parseAeroeBridgeklubPages,
} from "../../scripts/sources/aeroe-bridgeklub";
import { fixture, mappedFetch } from "./test-helpers";

const SCHEDULE_URL = "https://www.bridge.dk/4596/Turneringsoversigt.html";
const DETAILS_URL = "https://www.bridge.dk/4596/Klubben.html";
const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

async function pages(): Promise<[string, string]> {
  return Promise.all([
    fixture("aeroe-bridgeklub-schedule.html"),
    fixture("aeroe-bridgeklub-details.html"),
  ]);
}

describe("Ærø Bridgeklub source", () => {
  it("keeps named Monday blocks and the Wednesday holiday gaps in canonical schedules", async () => {
    const [schedule, details] = await pages();
    const parsed = parseAeroeBridgeklubPages(
      schedule,
      details,
      RETRIEVED_AT,
      NOW,
      "2026-09-13T16:58:43.000Z",
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rawRowCount).toBe(17);
    expect(parsed.candidates).toHaveLength(15);
    const monday = parsed.candidates.find(
      (item) => item.sourceEventId === "season-2026-27-monday-efterarsturnering",
    );
    expect(monday).toMatchObject({
      title: "Efterårsturnering",
      attendance: "registration",
      price: "Medlemmer gratis; gæster 30 kr.",
      location: { address: "Vestergade 32B, 1. sal", city: "Marstal" },
      occurrences: [],
      provenance: { sourceModifiedAt: "2026-09-13T16:58:43.000Z" },
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-09-07", startTime: "18:30" },
        rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261005T183000",
        exdates: [],
      },
    });
    expect(
      parsed.candidates.find(
        (item) => item.sourceEventId === "season-2026-27-monday-enkeltaftensturnering-traek-en-makker",
      ),
    ).toMatchObject({
      title: "Enkeltaftensturnering - træk en makker",
      occurrences: [{ date: "2026-10-12", startTime: "18:30" }],
    });
    const wednesday = parsed.candidates.find((item) => item.sourceEventId.endsWith("-wednesday"));
    expect(wednesday?.schedule).toMatchObject({
      kind: "recurring",
      dtstart: { date: "2026-09-02", startTime: "13:00" },
      rrule: "FREQ=WEEKLY;BYDAY=WE;UNTIL=20270526T130000",
      exdates: ["2026-12-23T13:00", "2026-12-30T13:00"],
    });
  });

  it("keeps local weekend events and tombstones the trip to Langeland", async () => {
    const [schedule, details] = await pages();
    const parsed = parseAeroeBridgeklubPages(schedule, details, RETRIEVED_AT, NOW);

    expect(parsed.excludedSourceEventIds).toContain(
      "season-2026-27-weekend-tur-til-langeland",
    );
    expect(parsed.warnings.join(" ")).toContain("Langeland");
    expect(parsed.candidates.map((item) => item.title)).toEqual(expect.arrayContaining([
      "Weekendbridge",
      "Julefrokost - træk en makker",
      "Generalforsamling",
    ]));
    expect(JSON.stringify(parsed.candidates)).not.toContain("Langeland");
  });

  it("keeps a recurring identity stable when a source time moves", async () => {
    const [schedule, details] = await pages();
    const movedSchedule = schedule.replace("Mandage kl. 18.30:", "Mandage kl. 18.45:");
    const movedDetails = details.replace("Mandag kl. 18.30", "Mandag kl. 18.45");
    const original = parseAeroeBridgeklubPages(schedule, details, RETRIEVED_AT, NOW);
    const moved = parseAeroeBridgeklubPages(movedSchedule, movedDetails, RETRIEVED_AT, NOW);
    expect(moved.errors).toEqual([]);
    expect(moved.candidates[0]!.sourceEventId).toBe(original.candidates[0]!.sourceEventId);
    expect(moved.candidates[0]!.schedule).not.toEqual(original.candidates[0]!.schedule);
  });

  it("keeps named weekend identities stable when rows are inserted or dates move", async () => {
    const [schedule, details] = await pages();
    const changed = schedule
      .replace(
        "<p>L&oslash;rdag d. 3. oktober</p>",
        "<p>L&oslash;rdag d. 26. september, s&aelig;son&aring;bning</p><p>L&oslash;rdag d. 3. oktober</p>",
      )
      .replace("12. december julefrokost", "19. december julefrokost");
    const parsed = parseAeroeBridgeklubPages(changed, details, RETRIEVED_AT, NOW);
    const julefrokost = parsed.candidates.find(
      (item) => item.sourceEventId === "season-2026-27-weekend-julefrokost-traek-en-makker",
    );

    expect(parsed.errors).toEqual([]);
    expect(julefrokost).toMatchObject({
      stableId:
        "aeroe-bridgeklub-season-2026-27-weekend-julefrokost-traek-en-makker",
      occurrences: [{ date: "2026-12-19" }],
    });
  });

  it("fails atomically when a date no longer matches its section weekday", async () => {
    const [schedule, details] = await pages();
    const broken = schedule.replace("12. oktober, enkeltaftensturnering", "13. oktober, enkeltaftensturnering");
    const result = await aeroeBridgeklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SCHEDULE_URL]: broken,
        [DETAILS_URL]: details,
      }),
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("ugedag og dato");
  });

  it("fails closed when the official venue or guest terms disappear", async () => {
    const [schedule, details] = await pages();
    const parsed = parseAeroeBridgeklubPages(
      schedule,
      details.replace("Vestergade 32B", "Ukendt sted").replace("g&aelig;ster betaler", "gæster inviteres"),
      RETRIEVED_AT,
      NOW,
    );
    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors.join(" ")).toContain("spillested");
  });

  it("collects both ISO-8859-1 pages and exposes an authoritative snapshot", async () => {
    const [schedule, details] = await pages();
    const result = await aeroeBridgeklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SCHEDULE_URL]: {
          status: 200,
          body: schedule,
          contentType: "text/html; charset=utf-8",
          headers: { "last-modified": "Sun, 13 Sep 2026 16:58:43 GMT" },
        },
        [DETAILS_URL]: details,
      }),
    });
    expect(result).toMatchObject({
      status: "complete",
      pagesFetched: 2,
      snapshotCoverage: "authoritative",
    });
    expect(result.candidates).toHaveLength(15);
  });
});
