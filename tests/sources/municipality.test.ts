import { describe, expect, it } from "vitest";

import {
  enrichMunicipalityCandidates,
  municipalitySource,
  parseFirstAgendaMeetings,
  parseMunicipalityPage,
} from "../../scripts/sources/municipality";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");

describe("Ærø Kommune source", () => {
  it("reads only Kommunalbestyrelsen and preserves wall-clock meeting times", async () => {
    const parsed = parseMunicipalityPage(
      await fixture("municipality.html"),
      NOW.toISOString(),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates).toHaveLength(1);
    const event = parsed.candidates[0]!;
    expect(event.stableId).toBe("aeroe-kommune-kommunalbestyrelsen-2026");
    expect(event.publication).toBe("trusted");
    expect(event.occurrences).toHaveLength(11);
    expect(event.occurrences[0]).toMatchObject({
      date: "2026-01-21",
      startTime: "19:00",
      allDay: false,
    });
    expect(event.occurrences.some(({ date }) => date === "2026-01-20")).toBe(false);
  });

  it("keeps the occurrence identity when a published day moves", async () => {
    const original = parseMunicipalityPage(
      await fixture("municipality.html"),
      NOW.toISOString(),
    ).candidates[0]!;
    const changed = parseMunicipalityPage(
      await fixture("municipality-changed.html"),
      NOW.toISOString(),
    ).candidates[0]!;
    const oldSeptember = original.occurrences.find(({ date }) => date.startsWith("2026-09"))!;
    const newSeptember = changed.occurrences.find(({ date }) => date.startsWith("2026-09"))!;

    expect(newSeptember.id).toBe(oldSeptember.id);
    expect(oldSeptember.date).toBe("2026-09-16");
    expect(newSeptember.date).toBe("2026-09-23");
  });

  it("enriches annual dates with FirstAgenda GUID, time, end and venue", async () => {
    const parsed = parseMunicipalityPage(
      await fixture("municipality.html"),
      NOW.toISOString(),
    );
    const agenda = parseFirstAgendaMeetings(
      JSON.parse(await fixture("firstagenda.json")),
    );

    expect(agenda.errors).toEqual([]);
    expect(agenda.meetings).toHaveLength(2);
    const warnings = enrichMunicipalityCandidates(parsed.candidates, agenda.meetings);
    const event = parsed.candidates[0]!;
    expect(warnings).toEqual([]);
    expect(event.occurrences).toHaveLength(12);
    expect(event.occurrences.find(({ date }) => date === "2026-09-16")).toMatchObject({
      id: "firstagenda-1ec7c87f-599a-4a09-a7fb-f24245b8ebae",
      startTime: "19:00",
      endTime: "21:30",
      location: { name: "Byrådssalen, Ærø Rådhus" },
    });
    expect(event.occurrences.find(({ date }) => date === "2026-03-04")).toMatchObject({
      id: "firstagenda-f7f5d790-f909-473b-a725-485cb57098ac",
      location: { name: "Teams" },
    });
    expect(event.provenance.sourceModifiedAt).toBe(
      "2026-09-09T16:05:33.286+02:00",
    );
  });

  it("keeps a FirstAgenda GUID stable when an annual meeting is moved", async () => {
    const parsed = parseMunicipalityPage(
      await fixture("municipality.html"),
      NOW.toISOString(),
    );
    const meeting = {
      id: "1ec7c87f-599a-4a09-a7fb-f24245b8ebae",
      date: "2026-09-23",
      startTime: "19:00",
      endDate: "2026-09-23",
      endTime: "21:30",
      location: "Byrådssalen, Ærø Rådhus",
    };

    const warnings = enrichMunicipalityCandidates(parsed.candidates, [meeting]);
    expect(warnings.join(" ")).toContain("2026-09-16 til 2026-09-23");
    expect(parsed.candidates[0]!.occurrences.find(({ id }) => id.includes(meeting.id))).toMatchObject({
      date: "2026-09-23",
      startTime: "19:00",
    });
  });

  it("returns an atomic partial result if required timing disappears", async () => {
    const html = (await fixture("municipality.html")).replace(
      "Mødetidspunkt kl. 19.00",
      "Tidspunkt oplyses senere",
    );
    const result = await municipalitySource.collect({
      fetch: mappedFetch({ [municipalitySource.definition.url]: html }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("mødetidspunkt");
  });

  it("distinguishes an HTTP failure from a parsed partial response", async () => {
    const result = await municipalitySource.collect({
      fetch: mappedFetch({
        [municipalitySource.definition.url]: { status: 503 },
      }),
      now: NOW,
    });
    expect(result.status).toBe("failed");
    expect(result.pagesFetched).toBe(0);
  });
});
