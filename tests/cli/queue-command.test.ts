import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatch } from "../../scripts/cli/commands";
import { getPaths } from "../../scripts/cli/config";
import * as model from "../../scripts/cli/model";
import { listPending } from "../../scripts/cli/review-store";
import { eventSchema } from "../../src/lib/schema";

const originalState = process.env.AEROEVENTS_STATE_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalState === undefined) delete process.env.AEROEVENTS_STATE_DIR;
  else process.env.AEROEVENTS_STATE_DIR = originalState;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function eventFile(
  rrule: string,
  scheduleOverrides: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aeroevents-queue-"));
  temporaryDirectories.push(root);
  process.env.AEROEVENTS_STATE_DIR = join(root, "state");
  const file = join(root, "event.yaml");
  await writeFile(file, toYaml({
    id: "monthly-club-night",
    title: "Månedlig klubaften",
    description: "Fast aktivitet fra klubbens offentlige side.",
    organizerId: "aeroe-kalenderen",
    organizerName: "Klubben",
    categoryIds: ["forening-faellesskab"],
    location: { name: "Klubhuset", city: "Marstal" },
    attendance: { kind: "members" },
    status: "scheduled",
    publication: "published",
    schedule: {
      kind: "recurring",
      dtstart: { kind: "timed", date: "2026-09-10", startTime: "18:00" },
      rrule,
      durationMinutes: 120,
      ...scheduleOverrides,
    },
    source: {
      sourceId: "manual",
      externalId: "monthly-club-night",
      url: "https://example.test/club-night",
      verifiedAt: "2026-09-14T10:00:00Z",
    },
  }));
  return file;
}

describe("manual review queue command", () => {
  it("queues one canonical recurring event without materialising dates", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const file = await eventFile("FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2");

    const args = [
      "queue",
      "--from",
      file,
      "--reason",
      "Sæsonens undtagelser skal kontrolleres",
      "--evidence",
      "Anden torsdag i måneden kl. 18-20",
    ];
    await dispatch(args);
    await dispatch(args);

    const candidates = await listPending(getPaths());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceId: "manual",
      sourceEventId: "monthly-club-night",
      event: {
        publication: "draft",
        schedule: {
          kind: "recurring",
          rrule: "FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2",
          durationMinutes: 120,
        },
      },
    });
    expect((candidates[0]?.event as { schedule?: { dates?: unknown[] } }).schedule?.dates).toBeUndefined();
    expect(candidates[0]?.reasons).toContain("Sæsonens undtagelser skal kontrolleres");
    expect(candidates[0]?.private).toEqual({
      parseEvidence: ["Anden torsdag i måneden kl. 18-20"],
    });
  });

  it("rejects a malformed recurrence before it reaches review", async () => {
    const file = await eventFile("NOT-A-RRULE");
    await expect(dispatch(["queue", "--from", file])).rejects.toThrow(/Gentagelsesreglen/);
    expect(await listPending(getPaths())).toEqual([]);
  });

  it("rejects a DTSTART that is outside the recurrence pattern", async () => {
    const file = await eventFile("FREQ=WEEKLY;BYDAY=FR");
    await expect(dispatch(["queue", "--from", file])).rejects.toThrow(/dtstart.*RRULE/i);
    expect(await listPending(getPaths())).toEqual([]);
  });

  it("rejects duration fields that conflict with the recurring date kind", async () => {
    const file = await eventFile("FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2", { durationDays: 1 });
    await expect(dispatch(["queue", "--from", file])).rejects.toThrow(/både durationMinutes og durationDays/);
    expect(await listPending(getPaths())).toEqual([]);
  });

  it("adds a review reason when an expanded occurrence collides with a known event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const file = await eventFile("FREQ=MONTHLY;BYDAY=TH;BYSETPOS=2");
    const candidate = eventSchema.parse(parseYaml(await readFile(file, "utf8")));
    const existing = eventSchema.parse({
      ...candidate,
      id: "known-club-night",
      publication: "published",
      source: {
        sourceId: "facebook",
        externalId: "known-club-night",
        url: "https://example.test/known-club-night",
      },
    });
    vi.spyOn(model, "validateAllPublicData").mockResolvedValue({
      repository: { events: [existing] },
    } as Awaited<ReturnType<typeof model.validateAllPublicData>>);

    await dispatch(["queue", "--from", file]);

    const candidates = await listPending(getPaths());
    expect(candidates[0]?.reasons).toContain(
      "Mulig dublet af known-club-night fra facebook (2026-09-10 kl. 18:00)",
    );
  });
});
