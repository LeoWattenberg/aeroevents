import { describe, expect, it } from "vitest";
import { formatReviewCandidate, parseReviewDecision } from "../../scripts/cli/review-display";
import type { ReviewCandidate } from "../../scripts/cli/review-store";

function candidate(event: unknown): ReviewCandidate {
  return {
    version: 1,
    candidateId: "0123456789abcdef",
    candidateKey: "source:one",
    payloadDigest: "digest",
    sourceId: "source",
    sourceEventId: "one",
    sourceUrl: "https://example.test/events/one",
    discoveredAt: "2026-09-14T10:00:00Z",
    reasons: ["Kræver redaktionel kontrol"],
    event,
  };
}

describe("interactive review display", () => {
  it("shows the source link, time, and full place for an explicit event", () => {
    const output = formatReviewCandidate(
      candidate({
        title: "Høstfest",
        location: {
          name: "Forsamlingshuset",
          address: "Torvet 1",
          postalCode: "5970",
          city: "Ærøskøbing",
        },
        schedule: {
          kind: "explicit",
          dates: [{ kind: "timed", date: "2026-10-03", startTime: "19:30", endTime: "21:30" }],
        },
      }),
      1,
      2,
    );

    expect(output).toContain("Kandidat 1 af 2");
    expect(output).toContain("Tid: 2026-10-03 kl. 19:30–21:30");
    expect(output).toContain("Sted: Forsamlingshuset, Torvet 1, 5970 Ærøskøbing");
    expect(output).toContain("Kilde: https://example.test/events/one");
  });

  it("shows recurring schedules and source-draft occurrences", () => {
    expect(
      formatReviewCandidate(
        candidate({
          title: "Ugentligt møde",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2026-09-15", startTime: "18:00" },
            rrule: "FREQ=WEEKLY;BYDAY=TU",
          },
        }),
        1,
        1,
      ),
    ).toContain("Tid: 2026-09-15 kl. 18:00; gentagelse: FREQ=WEEKLY;BYDAY=TU");

    expect(
      formatReviewCandidate(
        candidate({
          title: "Rå kandidat",
          occurrences: [{ date: "2026-09-20", allDay: true, timeUnknown: false }],
        }),
        1,
        1,
      ),
    ).toContain("Tid: 2026-09-20 (hele dagen)");
  });

  it("shows the matched post evidence without exposing the complete private text", () => {
    const value = candidate({
      title: "Fællesspisning",
      schedule: {
        kind: "explicit",
        dates: [{ kind: "timed", date: "2026-10-02", startTime: "18:30" }],
      },
    });
    value.private = {
      pastedDetails: "Kontakt privat@example.dk for flere oplysninger",
      parseEvidence: ["2. oktober kl. 18.30"],
    };
    const output = formatReviewCandidate(value, 1, 1);
    expect(output).toContain("Fundet tekst: 2. oktober kl. 18.30");
    expect(output).not.toContain("privat@example.dk");
  });

  it("accepts English and Danish yes/no answers", () => {
    expect(parseReviewDecision("y")).toBe("approve");
    expect(parseReviewDecision("YES")).toBe("approve");
    expect(parseReviewDecision("ja")).toBe("approve");
    expect(parseReviewDecision("n")).toBe("reject");
    expect(parseReviewDecision("nej")).toBe("reject");
    expect(parseReviewDecision("maybe")).toBeUndefined();
  });
});
