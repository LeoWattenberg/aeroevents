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
    ).toContain("Tid: hver tirsdag fra 2026-09-15 kl. 18:00 [FREQ=WEEKLY;BYDAY=TU]");

    expect(
      formatReviewCandidate(
        candidate({
          title: "Ugentligt møde uden oplyst startdato",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2000-01-04", startTime: "18:00" },
            startDateUnknown: true,
            rrule: "FREQ=WEEKLY;BYDAY=TU",
          },
        }),
        1,
        1,
      ),
    ).toContain("Tid: hver tirsdag kl. 18:00 [FREQ=WEEKLY;BYDAY=TU]");

    expect(
      formatReviewCandidate(
        candidate({
          title: "Sejlads",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2026-09-16", startTime: "18:00" },
            rrule: "FREQ=WEEKLY;WKST=MO;UNTIL=20261007T180000;BYDAY=WE",
            durationMinutes: 120,
          },
        }),
        1,
        1,
      ),
    ).toContain(
      "Tid: hver onsdag fra 2026-09-16 kl. 18:00–20:00 til 2026-10-07 kl. 18:00 " +
        "[FREQ=WEEKLY;WKST=MO;UNTIL=20261007T180000;BYDAY=WE]",
    );

    expect(
      formatReviewCandidate(
        candidate({
          title: "Månedligt møde",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2026-09-10", startTime: "18:00" },
            rrule: "FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2",
            durationMinutes: 120,
            exdates: ["2026-12-10T18:00"],
          },
        }),
        1,
        1,
      ),
    ).toContain(
      "Tid: hver anden torsdag i måneden fra 2026-09-10 kl. 18:00–20:00 med 1 undtagelse " +
        "[FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2]",
    );

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

  it("shows the DTSTART anchor and interval phase", () => {
    const weekly = formatReviewCandidate(
      candidate({
        title: "Træning hver anden uge",
        schedule: {
          kind: "recurring",
          dtstart: { kind: "timed", date: "2026-09-15", startTime: "18:00" },
          rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
        },
      }),
      1,
      1,
    );

    expect(weekly).toContain(
      "Tid: hver anden tirsdag fra 2026-09-15 kl. 18:00 " +
        "[FREQ=WEEKLY;INTERVAL=2;BYDAY=TU]",
    );

    const monthly = formatReviewCandidate(
      candidate({
        title: "Møde hver tredje måned",
        schedule: {
          kind: "recurring",
          dtstart: { kind: "timed", date: "2026-09-10", startTime: "18:00" },
          rrule: "FREQ=MONTHLY;INTERVAL=3;BYDAY=TH;BYSETPOS=2",
        },
      }),
      1,
      1,
    );

    expect(monthly).toContain(
      "Tid: hver 3. måned på månedens anden torsdag fra 2026-09-10 kl. 18:00 " +
        "[FREQ=MONTHLY;INTERVAL=3;BYDAY=TH;BYSETPOS=2]",
    );
  });

  it("accounts for recurrence limits, extra dates, exclusions, and overrides", () => {
    const output = formatReviewCandidate(
      candidate({
        title: "Afgrænset klubaften",
        schedule: {
          kind: "recurring",
          dtstart: { kind: "timed", date: "2026-09-10", startTime: "18:00" },
          rrule: "FREQ=MONTHLY;BYDAY=2TH;COUNT=6",
          durationMinutes: 120,
          exdates: ["2026-12-10T18:00", "2027-01-14T18:00"],
          rdates: [{ kind: "timed", date: "2026-12-17", startTime: "18:00" }],
          overrides: [
            { recurrenceId: "2026-10-08T18:00", status: "cancelled" },
            {
              recurrenceId: "2026-11-12T18:00",
              replacement: { kind: "timed", date: "2026-11-19", startTime: "19:00" },
            },
          ],
        },
      }),
      1,
      1,
    );

    expect(output).toContain(
      "Tid: hver anden torsdag i måneden fra 2026-09-10 kl. 18:00–20:00 6 gange " +
        "med 2 undtagelser, 1 ekstra dato og 2 ændrede forekomster " +
        "[FREQ=MONTHLY;BYDAY=2TH;COUNT=6]",
    );

    const localUntil = "FREQ=WEEKLY;BYDAY=MO;UNTIL=20270531T183000";
    expect(
      formatReviewCandidate(
        candidate({
          title: "Sæsonhold",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2026-09-07", startTime: "18:30" },
            rrule: localUntil,
          },
        }),
        1,
        1,
      ),
    ).toContain(
      `Tid: hver mandag fra 2026-09-07 kl. 18:30 til 2027-05-31 kl. 18:30 [${localUntil}]`,
    );
  });

  it("falls back to the exact rule rather than simplifying unsupported constraints", () => {
    for (const rrule of [
      "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9",
      "FREQ=WEEKLY;BYDAY=TU,IKKEENDAG",
      "FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2,3",
    ]) {
      const output = formatReviewCandidate(
        candidate({
          title: "Usikker gentagelse",
          schedule: {
            kind: "recurring",
            dtstart: { kind: "timed", date: "2026-09-15", startTime: "18:00" },
            rrule,
          },
        }),
        1,
        1,
      );

      expect(output).toContain(`Tid: 2026-09-15 kl. 18:00; gentagelse: ${rrule}`);
      expect(output).not.toContain("Tid: hver");
    }
  });

  it("falls back when recurrence change metadata cannot be counted safely", () => {
    const rrule = "FREQ=WEEKLY;BYDAY=TU";
    const output = formatReviewCandidate(
      candidate({
        title: "Ugyldig ekstra dato",
        schedule: {
          kind: "recurring",
          dtstart: { kind: "timed", date: "2026-09-15", startTime: "18:00" },
          rrule,
          rdates: ["2026-10-01"],
        },
      }),
      1,
      1,
    );

    expect(output).toContain(`Tid: 2026-09-15 kl. 18:00; gentagelse: ${rrule}`);
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

  it("accepts English and Danish approve, reject, and skip answers", () => {
    expect(parseReviewDecision("y")).toBe("approve");
    expect(parseReviewDecision("YES")).toBe("approve");
    expect(parseReviewDecision("ja")).toBe("approve");
    expect(parseReviewDecision("n")).toBe("reject");
    expect(parseReviewDecision("nej")).toBe("reject");
    expect(parseReviewDecision("s")).toBe("skip");
    expect(parseReviewDecision("SKIP")).toBe("skip");
    expect(parseReviewDecision("spring over")).toBe("skip");
    expect(parseReviewDecision("maybe")).toBeUndefined();
  });
});
