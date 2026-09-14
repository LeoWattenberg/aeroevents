import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectAllSources,
  SOURCE_ADAPTERS,
  type CollectionProgress,
} from "../../scripts/sources";
import { SOURCE_REGISTRY } from "../../scripts/sources/registry";
import type { CollectionResult } from "../../scripts/sources/types";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function completeResult(
  sourceId: "aeroe-kommune" | "aeroe-kirkeliv",
): CollectionResult {
  return {
    source: SOURCE_REGISTRY[sourceId],
    retrievedAt: "2026-09-14T10:00:00.000Z",
    pagesFetched: 1,
    warnings: [],
    status: "complete",
    candidates: [],
    errors: [],
  };
}

describe("collectAllSources progress", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports every concurrent start and completion while preserving result order", async () => {
    const municipality = deferred<CollectionResult>();
    const churchDesk = deferred<CollectionResult>();
    vi.spyOn(SOURCE_ADAPTERS["aeroe-kommune"], "collect").mockReturnValue(municipality.promise);
    vi.spyOn(SOURCE_ADAPTERS["aeroe-kirkeliv"], "collect").mockReturnValue(churchDesk.promise);

    const progress: CollectionProgress[] = [];
    const collection = collectAllSources({
      sourceIds: ["aeroe-kommune", "aeroe-kirkeliv"],
      onProgress: (event) => progress.push(event),
    });

    churchDesk.resolve(completeResult("aeroe-kirkeliv"));
    municipality.resolve(completeResult("aeroe-kommune"));
    const results = await collection;

    expect(
      progress.map((event) =>
        event.phase === "started"
          ? `${event.phase}:${event.source.id}:${event.position}/${event.total}`
          : `${event.phase}:${event.source.id}:${event.completed}/${event.total}`,
      ),
    ).toEqual([
      "started:aeroe-kommune:1/2",
      "started:aeroe-kirkeliv:2/2",
      "completed:aeroe-kirkeliv:1/2",
      "completed:aeroe-kommune:2/2",
    ]);
    expect(results.map((result) => result.source.id)).toEqual([
      "aeroe-kommune",
      "aeroe-kirkeliv",
    ]);
  });
});
