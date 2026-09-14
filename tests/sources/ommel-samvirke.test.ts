import { describe, expect, it } from "vitest";

import {
  collectOmmelSamvirke,
  parseOmmelRenderedCalendar,
  sanitizeOmmelRenderedHtml,
  type OmmelBrowserClient,
  type OmmelBrowserSnapshot,
} from "../../scripts/sources/ommel-samvirke";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const SOURCE_URL = "https://www.ommelsamvirke.dk/aktivitetskalender";

function snapshot(html: string, viewMonth = "2026-09-01"): OmmelBrowserSnapshot {
  return {
    requestedUrl: SOURCE_URL,
    finalUrl: SOURCE_URL,
    status: 200,
    contentType: "text/html; charset=utf-8",
    viewMonth,
    html,
  };
}

function fakeBrowser(
  snapshots: OmmelBrowserSnapshot[],
  actions: string[] = [],
): () => Promise<OmmelBrowserClient> {
  return async () => {
    let index = 0;
    return {
      async open(url) {
        actions.push(`open:${url}`);
        const value = snapshots[index++];
        if (!value) throw new Error("Manglende testsnapshot");
        return value;
      },
      async next() {
        actions.push("next");
        const value = snapshots[index++];
        if (!value) throw new Error("Manglende testsnapshot");
        return value;
      },
      async close() {
        actions.push("close");
      },
    };
  };
}

describe("Ommel Samvirke source", () => {
  it("groups recurring occurrences by a source-detail identity and strips contact PII", async () => {
    const html = await fixture("ommel-samvirke-calendar.html");
    const parsed = parseOmmelRenderedCalendar(
      html,
      SOURCE_URL,
      NOW.toISOString(),
      NOW,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(3);
    const gymnastics = parsed.candidates.find((candidate) => candidate.title === "Stolegymnastik");
    expect(gymnastics).toMatchObject({
      sourceId: "ommel-samvirke",
      publication: "trusted",
      attendance: "unknown",
      location: { name: "Beboerhuset" },
    });
    expect(gymnastics?.sourceEventId).toMatch(/^activity-[0-9a-f]{20}$/u);
    expect(gymnastics?.sourceEventId).not.toContain("stolegymnastik");
    expect(gymnastics?.occurrences.map((item) => item.date)).toEqual([
      "2026-09-14",
      "2026-09-21",
    ]);
    expect(gymnastics?.occurrences[0]?.id).toContain("2026-09-14-1000");
    expect(gymnastics?.reviewReasons).toEqual([]);
    expect(JSON.stringify(parsed.candidates)).not.toMatch(/stol@example\.dk|61 74 15 54|Privat Person/u);
  });

  it("keeps price, signup, and status information in prose under review", async () => {
    const html = (await fixture("ommel-samvirke-calendar.html")).replace(
      "Kom og spil petanque i hyggeligt selskab.",
      "Pris 20 kr. Tilmelding er nødvendig. Arrangementet er flyttet.",
    );
    const parsed = parseOmmelRenderedCalendar(
      html,
      SOURCE_URL,
      NOW.toISOString(),
      NOW,
    );
    const candidate = parsed.candidates.find((item) =>
      item.description?.includes("Tilmelding er nødvendig")
    );

    expect(candidate?.publication).toBe("review");
    expect(candidate?.reviewReasons.join(" ")).toMatch(/Pris|Tilmelding|statusændring/u);
  });

  it("does not collapse separate source activities merely because their titles match", async () => {
    const parsed = parseOmmelRenderedCalendar(
      await fixture("ommel-samvirke-calendar.html"),
      SOURCE_URL,
      NOW.toISOString(),
      NOW,
    );
    const petanque = parsed.candidates.filter((candidate) => candidate.title === "Petanque");
    expect(petanque).toHaveLength(2);
    expect(new Set(petanque.map((candidate) => candidate.sourceEventId)).size).toBe(2);
    expect(petanque.flatMap((candidate) => candidate.occurrences).map((item) => item.date).sort())
      .toEqual(["2026-09-24", "2026-10-01"]);
  });

  it("walks the bounded month range and records only sanitized rendered HTML", async () => {
    const html = await fixture("ommel-samvirke-calendar.html");
    const emptyOctober = `<!doctype html><main data-ommel-calendar-capture
      data-view-month="2026-10-01" data-visible-event-count="0"></main>`;
    const actions: string[] = [];
    const recorded: string[] = [];
    const result = await collectOmmelSamvirke(
      {
        now: NOW,
        fetch: globalThis.fetch,
        recordResponse: async (response) => {
          recorded.push(response.body);
        },
      },
      {
        monthsAhead: 1,
        createBrowser: fakeBrowser([snapshot(html), snapshot(emptyOctober, "2026-10-01")], actions),
      },
    );

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(2);
    expect(result.candidates).toHaveLength(3);
    expect(actions).toEqual([`open:${SOURCE_URL}`, "next", "close"]);
    expect(recorded).toHaveLength(2);
    expect(recorded.join(" ")).not.toMatch(/stol@example\.dk|61 74 15 54|Privat Person/u);
  });

  it("returns an atomic partial result when one visible dialog is malformed", async () => {
    const html = (await fixture("ommel-samvirke-calendar.html")).replace(
      '<div class="event-end-time"><p>Slut</p><p>21. Sep</p><p>12:00</p></div>',
      '<div class="event-end-time"><p>Slut</p><p>ukendt</p><p>12:00</p></div>',
    );
    const result = await collectOmmelSamvirke(
      { now: NOW, fetch: globalThis.fetch },
      { monthsAhead: 0, createBrowser: fakeBrowser([snapshot(html)]) },
    );

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    if (result.status === "partial") {
      expect(result.discardedCandidateCount).toBeGreaterThan(0);
      expect(result.errors.join(" ")).toContain("start- eller sluttid");
    }
  });

  it("rejects host escapes and missing captured dialogs", async () => {
    const html = await fixture("ommel-samvirke-calendar.html");
    const parsed = parseOmmelRenderedCalendar(
      html,
      "https://example.com/aktivitetskalender",
      NOW.toISOString(),
      NOW,
    );
    expect(parsed.errors.join(" ")).toContain("afviste URL'en");

    const missing = sanitizeOmmelRenderedHtml(
      '<main data-ommel-calendar-capture data-view-month="2026-09-01" data-visible-event-count="1"></main>',
    );
    const missingParsed = parseOmmelRenderedCalendar(
      missing,
      SOURCE_URL,
      NOW.toISOString(),
      NOW,
    );
    expect(missingParsed.errors.join(" ")).toContain("1 aktiviteter, men 0 dialoger");
  });
});
