import { describe, expect, it } from "vitest";

import {
  parseSoebyLokalraadPage,
  soebyLokalraadSource,
} from "../../scripts/sources/soeby-lokalraad";
import { fixture, mappedFetch } from "./test-helpers";

const URL = "https://soebylokalraad.dk/11/en/node/12";
const NOW = new Date("2026-09-14T10:00:00.000Z");

describe("Søby Lokalråd source", () => {
  it("splits all future occurrences in one Drupal node into composite stable IDs", async () => {
    const html = await fixture("soeby-lokalraad.html");
    const parsed = parseSoebyLokalraadPage(html, NOW.toISOString());

    expect(parsed.errors).toEqual([]);
    expect(parsed.candidates.map((candidate) => candidate.sourceEventId)).toEqual([
      "node-12-2026-09-17-15-00",
      "node-12-2026-09-20-15-00",
      "node-12-2026-10-01-16-00",
      "node-12-2026-10-03-13-30",
    ]);
    expect(parsed.candidates.map((candidate) => candidate.occurrences[0]!.date)).toEqual([
      "2026-09-17",
      "2026-09-20",
      "2026-10-01",
      "2026-10-03",
    ]);
    expect(parsed.candidates[0]).toMatchObject({
      stableId: "soeby-lokalraad-node-12-2026-09-17-15-00",
      title: "Åbent hus med bogudlevering i Aktivitetshuset",
      attendance: "public",
      publication: "review",
      occurrences: [{
        id: "node-12-2026-09-17-15-00-occurrence",
        startTime: "15:00",
        endTime: "18:00",
      }],
      provenance: {
        externalId: "node-12-2026-09-17-15-00",
        sourceUrl: URL,
      },
    });
    const meeting = parsed.candidates.find((candidate) =>
      candidate.sourceEventId === "node-12-2026-10-01-16-00"
    );
    expect(meeting).toMatchObject({ attendance: "unknown", publication: "review" });
    expect(meeting!.reviewReasons.join(" ")).toContain("ikke, om bestyrelsesmødet er offentligt");
    expect(parsed.candidates.every((candidate) => candidate.reviewReasons.length > 0)).toBe(true);
    expect(parsed.warnings.join(" ")).toContain("historiske");
  });

  it("excludes undated internal meetings and ordinary deadlines", async () => {
    const parsed = parseSoebyLokalraadPage(
      await fixture("soeby-lokalraad.html"),
      NOW.toISOString(),
    );
    const descriptions = parsed.candidates.map((candidate) => candidate.description).join(" ");
    expect(descriptions).not.toContain("Fælles lokalrådsmøde");
    expect(descriptions).not.toContain("Høringssvar");
  });

  it("returns an atomic partial result when one future event-like block is malformed", async () => {
    const html = (await fixture("soeby-lokalraad.html")).replace(
      "kl. 15-18.",
      "kl. 15-xx.",
    );
    const result = await soebyLokalraadSource.collect({
      fetch: mappedFetch({ [URL]: html }),
      now: NOW,
    });

    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("ugyldigt klokkeslæt");
    if (result.status === "partial") {
      expect(result.discardedCandidateCount).toBe(2);
    }
  });

  it("adds deterministic digests only when two distinct events share node, date, and time", async () => {
    const html = (await fixture("soeby-lokalraad.html")).replace(
      "<p>Næste møde aftalt til",
      "<p>Vi laver et Åbent Hus arrangement torsdag den 1. oktober 2026 kl. 16:00.</p><p>Næste møde aftalt til",
    );
    const first = parseSoebyLokalraadPage(html, NOW.toISOString());
    const second = parseSoebyLokalraadPage(html, NOW.toISOString());
    const collidingIds = first.candidates
      .map((candidate) => candidate.sourceEventId)
      .filter((id) => id.startsWith("node-12-2026-10-01-16-00-"));
    expect(collidingIds).toHaveLength(2);
    expect(new Set(collidingIds).size).toBe(2);
    expect(second.candidates.map((candidate) => candidate.sourceEventId)).toEqual(
      first.candidates.map((candidate) => candidate.sourceEventId),
    );
  });

  it("rejects a page whose canonical Drupal identity changes", async () => {
    const html = (await fixture("soeby-lokalraad.html"))
      .replace("/node/12\"", "/node/13\"")
      .replace("data-history-node-id=\"12\"", "data-history-node-id=\"13\"");
    const parsed = parseSoebyLokalraadPage(html, NOW.toISOString());
    expect(parsed.candidates).toEqual([]);
    expect(parsed.errors.join(" ")).toContain("Drupal-node");
  });
});
