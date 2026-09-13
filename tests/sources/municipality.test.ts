import { describe, expect, it } from "vitest";

import {
  municipalitySource,
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
