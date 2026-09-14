import { describe, expect, it } from "vitest";

import { folkedansSource, parseFolkedansPage } from "../../scripts/sources/folkedans";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const URL = "https://6165826142842.site123.me/";

describe("Ærø Folkedanserforening source", () => {
  it("uses only upcoming events and deduplicates Site123's repeated module", async () => {
    const result = await folkedansSource.collect({
      fetch: mappedFetch({ [URL]: await fixture("folkedans.html") }),
      now: NOW,
    });

    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("dubletter");
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).not.toContain("old-event");
    expect(result.candidates[0]).toMatchObject({
      stableId: "aeroe-folkedans-6a93f435e375d",
      price: "25 kr",
      attendance: "registration",
      bookingRequired: true,
      bookingUrl: "https://6165826142842.site123.me/begivenheder/familiedans#tilmeld",
      location: { address: "Pilebækken 30", city: "Ærøskøbing" },
      occurrences: [{ date: "2026-09-15", startTime: "16:30", endTime: "17:30" }],
    });
  });

  it("preserves an equal start/end time but routes it to review", async () => {
    const parsed = parseFolkedansPage(await fixture("folkedans.html"), NOW.toISOString());
    const candidate = parsed.candidates.find((value) => value.sourceEventId === "6a93f65a93765")!;
    expect(candidate.publication).toBe("review");
    expect(candidate.reviewReasons.join(" ")).toContain("ens");
    expect(candidate.occurrences[0]).toMatchObject({ startTime: "18:30", endTime: "18:30" });
  });

  it("does not expose any candidates when one upcoming event is malformed", async () => {
    const malformed = (await fixture("folkedans.html")).replaceAll(
      "09/22/2026 06:30 PM - 09/22/2026 06:30 PM",
      "ukendt tidspunkt",
    );
    const result = await folkedansSource.collect({
      fetch: mappedFetch({ [URL]: malformed }),
      now: NOW,
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
