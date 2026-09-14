import { describe, expect, it } from "vitest";

import {
  AEROE_SVOEMMEKLUB_CLOSURES_URL,
  AEROE_SVOEMMEKLUB_PLAN_URL,
  AEROE_SVOEMMEKLUB_PROGRAM_URL,
  aeroeSvoemmeklubSource,
  parseAeroeSvoemmeklubPages,
} from "../../scripts/sources/aeroe-svoemmeklub";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

async function pages(): Promise<[string, string, string]> {
  return Promise.all([
    fixture("aeroe-svoemmeklub-program.html"),
    fixture("aeroe-svoemmeklub-plan.html"),
    fixture("aeroe-svoemmeklub-closures.html"),
  ]);
}

describe("Ærø Svømmeklub source", () => {
  it("joins all 18 program rows to stable TeamIDs and bounded weekly schedules", async () => {
    const parsed = parseAeroeSvoemmeklubPages(...(await pages()), RETRIEVED_AT);

    expect(parsed.errors).toEqual([]);
    expect(parsed.season).toBe("2026/2027");
    expect(parsed.rawTeamCount).toBe(18);
    expect(parsed.candidates).toHaveLength(18);
    expect(parsed.candidates.map((candidate) => candidate.sourceEventId).sort()).toEqual(
      [518, 519, 522, 523, 524, 527, 528, 529, 530, 531, 532, 535, 537, 538, 539, 540, 541, 542]
        .map((id) => `team-${id}`)
        .sort(),
    );

    expect(parsed.candidates[0]).toMatchObject({
      sourceEventId: "team-518",
      stableId: "aeroe-svoemmeklub-team-518",
      title: "Forældre og Barn 1",
      attendance: "registration",
      availability: "unknown",
      bookingRequired: true,
      bookingUrl:
        "https://aero.klub-modul.dk/cms/ProfileMaintainEnrollment.aspx?TeamID=518",
      bookingDetails: "Aktuel tilmeldingsstatus på kilden: Venteliste.",
      publication: "review",
      price: "675 kr.",
      location: {
        name: "Ærø Svømmehal",
        address: "Markgade 1",
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [],
      schedule: {
        kind: "recurring",
        dtstart: { kind: "timed", date: "2026-09-08", startTime: "16:00" },
        rrule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270309T160000",
        rdates: [],
        exdates: ["2026-10-13T16:00", "2027-02-09T16:00"],
        overrides: [],
        durationMinutes: 30,
      },
    });
    expect(parsed.candidates.every((candidate) => candidate.occurrences.length === 0)).toBe(true);
    expect(parsed.candidates.every((candidate) => !("startDateUnknown" in candidate.schedule!))).toBe(true);
    expect(parsed.candidates.filter((candidate) => candidate.availability === "available")).toHaveLength(14);
    expect(JSON.stringify(parsed.candidates)).not.toContain("Skal Ikke Gemmes");
  });

  it("adds only verified holiday occurrences and retains ambiguous closure prose as warnings", async () => {
    const parsed = parseAeroeSvoemmeklubPages(...(await pages()), RETRIEVED_AT);
    const childMonday = parsed.candidates.find((candidate) => candidate.sourceEventId === "team-522")!;
    const adultMonday = parsed.candidates.find((candidate) => candidate.sourceEventId === "team-530")!;

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(18);
    expect(parsed.warnings.join(" ")).toContain("Juleferie");
    expect(parsed.warnings.join(" ")).toContain("tidligere");
    expect(childMonday.schedule?.exdates).toEqual([
      "2026-10-12T16:00",
      "2027-02-08T16:00",
      "2027-02-15T16:00",
    ]);
    expect(adultMonday.schedule?.exdates).toEqual([
      "2026-10-12T17:30",
      "2027-02-08T17:30",
      "2027-03-22T17:30",
      "2027-03-29T17:30",
      "2027-05-17T17:30",
    ]);
    expect(JSON.stringify(parsed.candidates.map((candidate) => candidate.schedule?.exdates))).not.toContain(
      "2026-12",
    );
  });

  it("collects the three official pages as one authoritative atomic snapshot", async () => {
    const [program, plan, closures] = await pages();
    const result = await aeroeSvoemmeklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [AEROE_SVOEMMEKLUB_PROGRAM_URL]: program,
        [AEROE_SVOEMMEKLUB_PLAN_URL]: plan,
        [AEROE_SVOEMMEKLUB_CLOSURES_URL]: closures,
      }),
    });

    expect(result).toMatchObject({
      status: "complete",
      pagesFetched: 3,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds: [],
      errors: [],
    });
    expect(result.candidates).toHaveLength(18);
  });

  it("atomically rejects missing, duplicate, and unsafe TeamID mappings", async () => {
    const [program, plan, closures] = await pages();
    const missing = parseAeroeSvoemmeklubPages(
      program,
      plan.replace('teamnr="FoB2"', 'teamnr="orphan"'),
      closures,
      RETRIEVED_AT,
    );
    const duplicate = parseAeroeSvoemmeklubPages(
      program,
      plan.replace("TeamID=519", "TeamID=518"),
      closures,
      RETRIEVED_AT,
    );
    const unsafe = parseAeroeSvoemmeklubPages(
      program,
      plan.replace(
        "ProfileMaintainEnrollment.aspx?TeamID=518",
        "https://evil.example/cms/ProfileMaintainEnrollment.aspx?TeamID=518",
      ),
      closures,
      RETRIEVED_AT,
    );

    expect(missing.candidates).toEqual([]);
    expect(missing.errors.join(" ")).toContain("TeamID-kobling");
    expect(duplicate.candidates).toEqual([]);
    expect(duplicate.errors.join(" ")).toContain("dublerede TeamID");
    expect(unsafe.candidates).toEqual([]);
    expect(unsafe.errors.join(" ")).toContain("usikkert tilmeldingslink");
  });

  it("validates club, season, weekday, range, and location identities", async () => {
    const [program, plan, closures] = await pages();
    const wrongWeekday = parseAeroeSvoemmeklubPages(
      program.replace('<span class="top_day">Tirsdag</span>', '<span class="top_day">Mandag</span>'),
      plan,
      closures,
      RETRIEVED_AT,
    );
    const wrongSeason = parseAeroeSvoemmeklubPages(
      program,
      plan,
      closures.replace("Ferieplan 2026/27", "Ferieplan 2025/26"),
      RETRIEVED_AT,
    );
    const wrongLocation = parseAeroeSvoemmeklubPages(
      program.replace("Svømmehallen, Bassin", "Ukendt bassin"),
      plan,
      closures,
      RETRIEVED_AT,
    );
    const secondTime = parseAeroeSvoemmeklubPages(
      program.replace(
        "Tirsdag</span> kl. 16:00 - 16:30",
        "Tirsdag</span> kl. 16:00 - 16:30 Onsdag kl. 17:00 - 18:00",
      ),
      plan,
      closures,
      RETRIEVED_AT,
    );

    expect(wrongWeekday.candidates).toEqual([]);
    expect(wrongWeekday.errors.join(" ")).toContain("ugedag");
    expect(wrongSeason.candidates).toEqual([]);
    expect(wrongSeason.errors.join(" ")).toContain("matcher ikke programsæsonen");
    expect(wrongLocation.candidates).toEqual([]);
    expect(wrongLocation.errors.join(" ")).toContain("svømmested");
    expect(secondTime.candidates).toEqual([]);
    expect(secondTime.errors.join(" ")).toContain("tidsinterval");
  });

  it("reports fetch failures without exposing partial candidates", async () => {
    const [program] = await pages();
    const result = await aeroeSvoemmeklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [AEROE_SVOEMMEKLUB_PROGRAM_URL]: program,
        [AEROE_SVOEMMEKLUB_PLAN_URL]: { status: 503 },
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      pagesFetched: 1,
      candidates: [],
    });
  });
});
