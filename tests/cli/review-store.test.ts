import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliPaths } from "../../scripts/cli/config";
import {
  enqueueCandidate,
  clearPendingCandidate,
  findPending,
  getReviewDecision,
  listPending,
  markApproved,
  markRejected,
} from "../../scripts/cli/review-store";

const temporaryDirectories: string[] = [];

async function paths(): Promise<CliPaths> {
  const root = await mkdtemp(join(tmpdir(), "aeroevents-review-"));
  temporaryDirectories.push(root);
  const state = join(root, "state");
  return {
    repo: join(root, "repo"),
    state,
    manualEvents: join(root, "repo/data/manual/events"),
    importedEvents: join(root, "repo/data/imported"),
    overrides: join(root, "repo/data/overrides"),
    sourceStatus: join(root, "repo/data/source-status.json"),
    reviewPending: join(state, "review/pending"),
    reviewApproved: join(state, "review/approved"),
    reviewRejected: join(state, "review/rejected"),
    raw: join(state, "raw"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("private editorial queue", () => {
  it("is idempotent and never copies private notes into an approval marker", async () => {
    const config = await paths();
    const input = {
      sourceId: "facebook",
      sourceEventId: "1234",
      sourceUrl: "https://www.facebook.com/events/1234",
      discoveredAt: "2026-09-13T10:00:00.000Z",
      reasons: ["Kræver gennemsyn"],
      event: { id: "test-event", title: "Test" },
      private: { pastedDetails: "privat afsender@example.dk" },
    };

    expect(await enqueueCandidate(config, input)).toBe("created");
    expect(
      await enqueueCandidate(config, {
        ...input,
        discoveredAt: "2026-09-14T10:00:00.000Z",
        private: { pastedDetails: "opdateret privat tekst" },
      }),
    ).toBe("already-pending");
    const [candidate] = await listPending(config);
    expect(candidate).toBeDefined();
    expect(candidate?.discoveredAt).toBe("2026-09-14T10:00:00.000Z");
    expect(candidate?.private).toEqual({ pastedDetails: "opdateret privat tekst" });
    await markApproved(config, candidate!, "data/manual/events/test-event.yaml");

    const marker = await readFile(join(config.reviewApproved, `${candidate!.candidateId}.json`), "utf8");
    expect(marker).not.toContain("afsender@example.dk");
    expect(await enqueueCandidate(config, input)).toBe("approved");

    expect(await enqueueCandidate(config, { ...input, event: { ...input.event, title: "Ny titel" } })).toBe(
      "updated",
    );
  });

  it("keeps rejected source identities rejected on later runs", async () => {
    const config = await paths();
    const input = {
      sourceId: "aeroe-kirkeliv",
      sourceEventId: "abc",
      sourceUrl: "https://example.test/abc",
      discoveredAt: "2026-09-13T10:00:00.000Z",
      event: { id: "abc", title: "Anden kirkelig aktivitet" },
    };
    await enqueueCandidate(config, input);
    const candidate = await findPending(config, "");
    await markRejected(config, candidate, "Uden for kalenderens område");
    expect(await listPending(config)).toEqual([]);
    expect(await getReviewDecision(config, input)).toBe("rejected");
    expect(await enqueueCandidate(config, input)).toBe("rejected");
  });

  it("clears stale pending work when source policy later permits automatic publication", async () => {
    const config = await paths();
    const input = {
      sourceId: "aeroe-kirkeliv",
      sourceEventId: "now-trusted",
      sourceUrl: "https://example.test/now-trusted",
      discoveredAt: "2026-09-13T10:00:00.000Z",
      event: { id: "now-trusted", title: "Gudstjeneste" },
    };
    await enqueueCandidate(config, input);
    expect(await getReviewDecision(config, input)).toBe("pending");
    await clearPendingCandidate(config, input);
    expect(await getReviewDecision(config, input)).toBeUndefined();
  });

  it("does not reopen an approval only because its last-seen timestamp advanced", async () => {
    const config = await paths();
    const input = {
      sourceId: "aeroe-kirkeliv",
      sourceEventId: "stable",
      sourceUrl: "https://example.test/stable",
      discoveredAt: "2026-09-13T10:00:00.000Z",
      event: {
        id: "stable",
        title: "Gudstjeneste",
        publication: "published",
        source: { sourceId: "aeroe-kirkeliv", externalId: "stable", verifiedAt: "2026-09-13T10:00:00Z" },
      },
    };
    await enqueueCandidate(config, input);
    const candidate = await findPending(config, "");
    await markApproved(config, candidate, "data/overrides/stable.yaml");
    expect(
      await enqueueCandidate(config, {
        ...input,
        discoveredAt: "2026-09-14T10:00:00.000Z",
        event: {
          ...input.event,
          publication: "draft",
          source: { ...input.event.source, verifiedAt: "2026-09-14T10:00:00Z" },
        },
      }),
    ).toBe("approved");
    expect(
      await enqueueCandidate(config, {
        ...input,
        event: { ...input.event, title: "Ændret gudstjeneste" },
      }),
    ).toBe("updated");
    expect((await listPending(config))[0]?.reasons).toContain(
      "Kandidaten har ændret sig siden sidste godkendelse",
    );
  });

  it("reopens an approval when a new duplicate risk appears", async () => {
    const config = await paths();
    const input = {
      sourceId: "aeroe-kirkeliv",
      sourceEventId: "duplicate-later",
      sourceUrl: "https://example.test/duplicate-later",
      discoveredAt: "2026-09-13T10:00:00.000Z",
      reasons: ["Kildeadapteren kræver redaktionel kontrol"],
      event: { id: "duplicate-later", title: "Fælles arrangement" },
    };
    await enqueueCandidate(config, input);
    const candidate = await findPending(config, "");
    await markApproved(config, candidate, "data/overrides/duplicate-later.yaml");

    expect(await enqueueCandidate(config, input)).toBe("approved");
    expect(
      await enqueueCandidate(config, {
        ...input,
        reasons: [
          " Kildeadapteren kræver redaktionel kontrol ",
          "Kildeadapteren kræver redaktionel kontrol",
        ],
      }),
    ).toBe("approved");
    expect(
      await enqueueCandidate(config, {
        ...input,
        reasons: [
          "Mulig dublet af another-source-event fra another-source",
          "Kildeadapteren kræver redaktionel kontrol",
        ],
      }),
    ).toBe("updated");
    expect((await listPending(config))[0]?.reasons).toContain(
      "Mulig dublet af another-source-event fra another-source",
    );

    expect(await enqueueCandidate(config, input)).toBe("approved");
    expect(await listPending(config)).toEqual([]);
  });
});
