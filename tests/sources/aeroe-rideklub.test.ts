import { describe, expect, it } from "vitest";

import {
  aeroeRideklubSource,
  parseAeroeRideklubPage,
} from "../../scripts/sources/aeroe-rideklub";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const SOURCE_URL = "https://www.aeroerideklub.dk/events-1";

describe("Ærø Rideklub source", () => {
  it("parses stable slugs, local intervals, access signals, and cancellation", async () => {
    const parsed = parseAeroeRideklubPage(
      await fixture("aeroe-rideklub.html"),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.candidates[0]).toMatchObject({
      stableId: "aeroe-rideklub-nisseoptog",
      sourceEventId: "nisseoptog",
      title: "Nisseoptog",
      occurrences: [{ date: "2026-12-20", startTime: "00:00", endTime: "16:00" }],
      attendance: "unknown",
      publication: "review",
      provenance: {
        sourceUrl: "https://www.aeroerideklub.dk/events-1/nisseoptog",
      },
    });
    expect(parsed.candidates[0]!.reviewReasons.join(" ")).toContain("midnat");
    expect(parsed.candidates[1]).toMatchObject({
      sourceEventId: "ridelejr-2027",
      attendance: "registration",
      bookingRequired: true,
      location: {
        name: "Ærø Rideklub",
        address: "Vråvejen 16C",
        postalCode: "5970",
        city: "Ærøskøbing",
      },
      occurrences: [{
        date: "2027-07-02",
        startTime: "10:00",
        endDate: "2027-07-04",
        endTime: "18:00",
      }],
    });
    expect(parsed.candidates[2]).toMatchObject({
      status: "cancelled",
      attendance: "members",
      occurrences: [{ date: "2027-04-24", allDay: true }],
    });
  });

  it("keeps the source identity when an event date moves", async () => {
    const html = await fixture("aeroe-rideklub.html");
    const original = parseAeroeRideklubPage(html, NOW.toISOString()).candidates[0]!;
    const moved = parseAeroeRideklubPage(
      html
        .replaceAll("2026-12-20", "2026-12-21")
        .replace("søndag den 20.", "mandag den 21."),
      NOW.toISOString(),
    ).candidates[0]!;

    expect(moved.sourceEventId).toBe(original.sourceEventId);
    expect(moved.stableId).toBe(original.stableId);
    expect(moved.occurrences[0]!.date).toBe("2026-12-21");
  });

  it("atomically rejects duplicate or unsafe detail links", async () => {
    const html = await fixture("aeroe-rideklub.html");
    const duplicate = html.replace("/events-1/arbejdsdag", "/events-1/nisseoptog");
    const duplicateResult = await aeroeRideklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: duplicate }),
    });
    const unsafe = parseAeroeRideklubPage(
      html.replace("/events-1/nisseoptog", "https://evil.example/events-1/nisseoptog"),
      NOW.toISOString(),
    );

    expect(duplicateResult.status).toBe("partial");
    expect(duplicateResult.candidates).toEqual([]);
    expect(duplicateResult.errors.join(" ")).toContain("samme eventlink");
    expect(unsafe.errors.join(" ")).toContain("usikkert link");
  });

  it("atomically rejects reversed date ranges and oversized source fields", async () => {
    const html = await fixture("aeroe-rideklub.html");
    const reversed = await aeroeRideklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: html.replaceAll("2027-07-02", "2027-07-05"),
      }),
    });
    const oversizedSlug = parseAeroeRideklubPage(
      html.replace("/events-1/nisseoptog", `/events-1/${"a".repeat(101)}`),
      NOW.toISOString(),
    );
    const oversizedAddress = parseAeroeRideklubPage(
      html.replace("Vråvejen 16C", "A".repeat(301)),
      NOW.toISOString(),
    );

    expect(reversed.status).toBe("partial");
    expect(reversed.candidates).toEqual([]);
    expect(reversed.errors.join(" ")).toContain("slutter før startdatoen");
    expect(oversizedSlug.errors.join(" ")).toContain("ugyldigt eventlink");
    expect(oversizedAddress.errors.join(" ")).toContain("for langt stedfelt");
  });

  it("rejects incomplete timed ranges and keeps member access alongside registration", async () => {
    const html = await fixture("aeroe-rideklub.html");
    const incompleteRange = await aeroeRideklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace(
          '<span class="eventlist-meta-time"><time class="event-time-localized" datetime="2027-07-04">18.00</time></span>',
          "",
        ),
      }),
    });
    const membersWithRegistration = parseAeroeRideklubPage(
      html.replace(
        "Tilmelding kræves. Tre dage med ridning.",
        "Tilmelding kræves. Kun for medlemmer.",
      ),
      NOW.toISOString(),
    ).candidates.find((candidate) => candidate.sourceEventId === "ridelejr-2027");

    expect(incompleteRange.status).toBe("partial");
    expect(incompleteRange.candidates).toEqual([]);
    expect(incompleteRange.errors.join(" ")).toContain("mangler start- eller sluttid");
    expect(membersWithRegistration).toMatchObject({
      attendance: "members",
      bookingRequired: true,
    });
  });

  it("collects only the rolling year and treats an empty source as partial", async () => {
    const html = await fixture("aeroe-rideklub.html");
    const result = await aeroeRideklubSource.collect({
      now: NOW,
      fetch: mappedFetch({ [SOURCE_URL]: html }),
    });
    const empty = await aeroeRideklubSource.collect({
      now: NOW,
      fetch: mappedFetch({
        [SOURCE_URL]: html.replace(/<article[\s\S]*<\/article>/g, ""),
      }),
    });

    expect(result.status).toBe("complete");
    expect(result.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "nisseoptog",
      "ridelejr-2027",
      "arbejdsdag",
    ]);
    expect(empty.status).toBe("partial");
    expect(empty.candidates).toEqual([]);
  });
});
