import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  momoyogaScheduleUrl,
  momoyogaSource,
  momoyogaWeekStarts,
  parseMomoyogaSchedule,
} from "../../scripts/sources/momoyoga";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const ZONE = "Europe/Copenhagen";

function generatedWeekHtml(weekStart: string): string {
  const week = DateTime.fromISO(weekStart, { zone: ZONE });
  const previous = week.minus({ weeks: 1 }).toISODate();
  const next = week.plus({ weeks: 1 }).toISODate();
  const id = Number(weekStart.replaceAll("-", ""));
  const start = week.set({ hour: 18, minute: 0 });
  const end = start.plus({ hours: 1 });
  const options = JSON.stringify({
    profileName: "nurtureaeroe",
    lesson: {
      id,
      title: "Flow Yoga",
      detailUrl: `/nurtureaeroe/lesson/${id}/flow-yoga/`,
      timeFrom: start.toISO(),
      timeTo: end.toISO(),
      isCancelled: false,
      isBookable: true,
      requiresOrderToBook: true,
      isFree: false,
      spotsTotal: 12,
      spotsOpen: 2,
      states: [],
      room: { name: "Ritual – Ærø" },
    },
  });
  return `<!doctype html>
    <nav class="schedule-pagination">
      <a class="week-change" href="?date=${previous}">Forrige</a>
      <a class="week-change" href="?date=${next}">Næste</a>
    </nav>
    <main id="schedule"><section class="schedule-day">
      <article class="schedule-lesson">
        <div data-component="LessonActionButton" data-options='${options}'></div>
      </article>
    </section></main>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("Ritual Momoyoga source", () => {
  it("deduplicates rendered action buttons and allowlists only group yoga", async () => {
    const html = await fixture("momoyoga-week.html");
    const navigation = html.match(/<nav class="schedule-pagination">[\s\S]*?<\/nav>/)?.[0];
    expect(navigation).toBeDefined();
    const parsed = parseMomoyogaSchedule(
      html.replace("</body>", `${navigation}</body>`),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.weekStart).toBe("2026-09-14");
    expect(parsed.listedLessonCount).toBe(3);
    expect(parsed.excludedLessonCount).toBe(1);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      stableId: "ritual-momoyoga-304",
      title: "Flow Yoga",
      attendance: "registration",
      bookingRequired: true,
      bookingDetails: "1 af 12 pladser er ledige.",
      location: {
        name: "Ritual Studio",
        address: "Tranderupgade 53",
        postalCode: "5970",
        city: "Ærøskøbing",
      },
      occurrences: [{ date: "2026-09-15", startTime: "17:00", endTime: "18:15" }],
      provenance: { sourceModifiedAt: "2026-09-01T08:00:00.000Z" },
    });
    expect(parsed.candidates[1]).toMatchObject({
      stableId: "ritual-momoyoga-305",
      status: "cancelled",
      availability: "sold-out",
      price: "Gratis",
    });
    expect(JSON.stringify(parsed.candidates)).not.toContain("Massage / facial");
  });

  it("rejects conflicting duplicate structured components", async () => {
    const html = await fixture("momoyoga-week.html");
    const conflicting = html.replace(
      '"timeTo":"2026-09-15T18:15:00+02:00"',
      '"timeTo":"2026-09-15T18:30:00+02:00"',
    );
    const parsed = parseMomoyogaSchedule(conflicting, NOW.toISOString());

    expect(parsed.errors.some((error) => error.includes("modstridende data"))).toBe(true);
  });

  it("fetches the bounded 12-month week window before completing", async () => {
    const weeks = momoyogaWeekStarts(NOW);
    const requests: string[] = [];
    const result = await momoyogaSource.collect({
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        const date = new URL(url).searchParams.get("date")!;
        return htmlResponse(generatedWeekHtml(date));
      },
    });

    expect(result.status).toBe("complete");
    expect(result.pagesFetched).toBe(weeks.length);
    expect(requests).toEqual(weeks.map(momoyogaScheduleUrl));
    expect(result.candidates).toHaveLength(weeks.length);
  });

  it("atomically discards prior weeks if a later week fails", async () => {
    let calls = 0;
    const result = await momoyogaSource.collect({
      now: NOW,
      fetch: async (input) => {
        calls += 1;
        if (calls === 2) return htmlResponse("upstream failed", 502);
        const date = new URL(String(input)).searchParams.get("date")!;
        return htmlResponse(generatedWeekHtml(date));
      },
    });

    expect(result.status).toBe("partial");
    expect(result.pagesFetched).toBe(1);
    expect(result.candidates).toEqual([]);
    expect(result.status === "partial" && result.discardedCandidateCount).toBe(1);
  });
});
