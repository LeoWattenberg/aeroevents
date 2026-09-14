import { describe, expect, it } from "vitest";

import { klatreklubSource, parseKlatreklubPage } from "../../scripts/sources/klatreklub";
import { parseParkinsonAeroePage, parkinsonAeroeSource } from "../../scripts/sources/parkinson-aeroe";
import { parseTennisklubPage, tennisklubSource } from "../../scripts/sources/tennisklub";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const RETRIEVED_AT = NOW.toISOString();

describe("fixed activity sources with unknown season exceptions", () => {
  it("parses all four Klatreklub rules into a bounded review horizon", async () => {
    const html = await fixture("klatreklub.html");
    const parsed = parseKlatreklubPage(html, RETRIEVED_AT, NOW);
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(4);
    expect(parsed.candidates[0]).toMatchObject({
      stableId: "aeroe-klatreklub-monday-kids-club",
      publication: "review",
    });
    expect(parsed.candidates[0]!.occurrences[0]).toMatchObject({ date: "2026-09-14", startTime: "16:30", endTime: "18:00" });
    expect(parsed.candidates[3]!.occurrences[0]).toMatchObject({ date: "2026-10-11", startTime: "10:00" });
    expect(parsed.candidates.every((item) => item.reviewReasons.join(" ").includes("sæson"))).toBe(true);

    const collected = await klatreklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ "https://aekk.klub-modul.dk/default.aspx": html }),
    });
    expect(collected.status).toBe("complete");
  });

  it("parses five tennis rules without persisting the contact phone number", async () => {
    const html = await fixture("tennisklub.html");
    const parsed = parseTennisklubPage(html, RETRIEVED_AT, NOW);
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(5);
    expect(parsed.candidates[0]).toMatchObject({ title: "Kaffetennis" });
    expect(parsed.candidates[0]!.occurrences[0]).toMatchObject({ date: "2026-09-14", startTime: "09:00", endTime: "12:00" });
    expect(parsed.candidates[4]).toMatchObject({
      title: "Slagtræning med boldmaskine",
      attendance: "registration",
      bookingRequired: true,
    });
    expect(parsed.candidates[4]!.occurrences[0]).toMatchObject({ date: "2026-09-20", startTime: "17:00", endTime: "18:00" });
    expect(JSON.stringify(parsed.candidates)).not.toContain("26 16 18 81");

    const collected = await tennisklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ "https://aeroetennisklub.dk/faste-aktiviteter/": html }),
    });
    expect(collected.status).toBe("complete");
  });

  it("uses Parkinsonforeningen's stable club post ID and first-Tuesday rule", async () => {
    const html = await fixture("parkinson-aeroe.html");
    const parsed = parseParkinsonAeroePage(html, RETRIEVED_AT, NOW);
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      sourceEventId: "club-3976-monthly-meeting",
      attendance: "members",
      publication: "review",
      location: { name: "Rise Beboerhus", address: "Store Rise Landevej 13" },
    });
    expect(parsed.candidates[0]!.occurrences[0]).toMatchObject({ date: "2026-10-06", startTime: "15:00", endTime: "16:30" });
    expect(JSON.stringify(parsed.candidates)).not.toContain("2621");

    const collected = await parkinsonAeroeSource.collect({
      now: NOW,
      fetch: mappedFetch({ "https://parkinson.dk/kredse/2823-fyn/klubber/": html }),
    });
    expect(collected.status).toBe("complete");
  });

  it("fails atomically when a published fixed rule disappears", async () => {
    const tennis = (await fixture("tennisklub.html")).replace("Fyraftenstennis", "Privat træning");
    expect(parseTennisklubPage(tennis, RETRIEVED_AT, NOW)).toMatchObject({ candidates: [], errors: expect.any(Array) });
    const climbing = (await fixture("klatreklub.html")).replace("Onsdag:", "Tirsdag:");
    expect(parseKlatreklubPage(climbing, RETRIEVED_AT, NOW)).toMatchObject({ candidates: [], errors: expect.any(Array) });
  });
});
