import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { loadRepository, resolvePublicData, writeGeneratedData } from "../src/lib/repository";
import { CALENDAR_ZONE } from "../src/lib/schedule";

const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeroevents-test-"));
  temporaryRoots.push(root);
  await Promise.all([
    fs.mkdir(path.join(root, "data/manual/events"), { recursive: true }),
    fs.mkdir(path.join(root, "data/imported"), { recursive: true }),
    fs.mkdir(path.join(root, "data/overrides"), { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(root, "data/categories.yaml"),
    toYaml([
      { id: "andet", name: "Andet", color: "#656b70" },
      { id: "musik-kultur", name: "Musik og kultur", color: "#a44432" },
    ]),
  );
  await fs.writeFile(
    path.join(root, "data/organizers.yaml"),
    toYaml([{ id: "arrangoer", name: "Arrangør" }]),
  );
  await fs.writeFile(
    path.join(root, "data/sources.yaml"),
    toYaml([
      { id: "manual", name: "Manuel", publication: "review", enabled: true },
      { id: "trusted", name: "Betroet", publication: "automatic", enabled: true },
    ]),
  );
  return root;
}

const importedEvent = {
  id: "trusted-42",
  title: "Oprindelig titel",
  description: "Offentlig beskrivelse",
  organizerId: "arrangoer",
  categoryIds: ["andet"],
  attendance: { kind: "public" },
  status: "scheduled",
  publication: "published",
  schedule: {
    kind: "explicit",
    dates: [{ kind: "timed", date: "2026-10-10", startTime: "10:00" }],
  },
  source: { sourceId: "trusted", externalId: "42", url: "https://example.test/events/42" },
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("repository pipeline", () => {
  it("validates the checked-in registries without example events", async () => {
    const repository = await loadRepository(process.cwd());
    expect(repository.events.some((event) => event.id.startsWith("eksempel-") || event.title.startsWith("Eksempel:"))).toBe(false);
    for (const event of repository.events.filter((event) =>
      /koncert/iu.test(`${event.title}\n${event.description ?? ""}`)
    )) {
      expect(event.categoryIds, event.title).toContain("musik-kultur");
      expect(event.categoryIds, event.title).not.toContain("andet");
    }
  });

  it("keeps manual overrides when an imported snapshot is loaded repeatedly", async () => {
    const root = await fixtureRoot();
    const snapshot = { sourceId: "trusted", verifiedAt: "2026-09-13T12:00:00Z", events: [importedEvent] };
    await fs.writeFile(path.join(root, "data/imported/trusted.json"), JSON.stringify(snapshot));
    await fs.writeFile(
      path.join(root, "data/overrides/trusted-42.yaml"),
      toYaml({ eventId: "trusted-42", set: { title: "Redaktionelt rettet titel" } }),
    );

    const first = await loadRepository(root);
    const second = await loadRepository(root);
    expect(first.events).toEqual(second.events);
    expect(first.events[0]?.title).toBe("Redaktionelt rettet titel");
    expect(first.events[0]?.source.externalId).toBe("42");
  });

  it("reversibly suppresses registered duplicates while retaining their source records", async () => {
    const root = await fixtureRoot();
    const duplicate = {
      ...importedEvent,
      id: "manual-copy",
      title: "Kopi af oprindelig titel",
      source: { sourceId: "manual" },
    };
    await fs.writeFile(
      path.join(root, "data/imported/trusted.json"),
      JSON.stringify({ sourceId: "trusted", verifiedAt: "2026-09-13T12:00:00Z", events: [importedEvent] }),
    );
    await fs.writeFile(path.join(root, "data/manual/events/manual-copy.yaml"), toYaml(duplicate));
    await fs.writeFile(
      path.join(root, "data/deduplications.yaml"),
      toYaml([{ canonicalEventId: "trusted-42", duplicateEventIds: ["manual-copy"] }]),
    );

    const repository = await loadRepository(root);
    expect(repository.events.map((event) => event.id)).toEqual(["trusted-42"]);
    expect(repository.suppressedEvents.map((event) => event.id)).toEqual(["manual-copy"]);
    expect(repository.deduplications).toEqual([
      { canonicalEventId: "trusted-42", duplicateEventIds: ["manual-copy"] },
    ]);
  });

  it("keeps a suppression tombstone if a duplicate temporarily leaves its source snapshot", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(
      path.join(root, "data/imported/trusted.json"),
      JSON.stringify({ sourceId: "trusted", verifiedAt: "2026-09-13T12:00:00Z", events: [importedEvent] }),
    );
    await fs.writeFile(
      path.join(root, "data/deduplications.yaml"),
      toYaml([{ canonicalEventId: "trusted-42", duplicateEventIds: ["missing"] }]),
    );
    const repository = await loadRepository(root);
    expect(repository.events).toHaveLength(1);
    expect(repository.suppressedEvents).toEqual([]);
    expect(repository.deduplications[0]?.duplicateEventIds).toEqual(["missing"]);
  });

  it("rejects a deduplication whose canonical event is missing", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(
      path.join(root, "data/deduplications.yaml"),
      toYaml([{ canonicalEventId: "missing", duplicateEventIds: ["trusted-42"] }]),
    );
    await expect(loadRepository(root)).rejects.toThrow("ukendt kanonisk event: missing");
  });

  it("publishes only approved repository data and never reads the private state directory", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(
      path.join(root, "data/manual/events/draft.yaml"),
      toYaml({ ...importedEvent, id: "email-draft", publication: "draft", source: { sourceId: "manual" } }),
    );
    const privateState = await fs.mkdtemp(path.join(os.tmpdir(), "aeroevents-private-"));
    temporaryRoots.push(privateState);
    await fs.writeFile(
      path.join(privateState, "candidate.json"),
      JSON.stringify({ submitterEmail: "privat@example.test", title: "Ikke godkendt" }),
    );

    const resolved = await writeGeneratedData(root, DateTime.fromISO("2026-09-13T12:00:00", { zone: CALENDAR_ZONE }));
    expect(resolved.publicEvents).toEqual([]);
    const generated = await fs.readFile(path.join(root, "data/generated/events.json"), "utf8");
    expect(generated).not.toContain("privat@example.test");
    expect(generated).not.toContain("Ikke godkendt");
  });

  it("rejects an event that references an unknown category", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(
      path.join(root, "data/manual/events/bad.yaml"),
      toYaml({ ...importedEvent, id: "bad-event", categoryIds: ["ukendt"], source: { sourceId: "manual" } }),
    );
    await expect(loadRepository(root)).rejects.toThrow("Ukendt kategori ukendt");
  });

  it("accepts a named event organizer that is not the source calendar owner", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(
      path.join(root, "data/imported/trusted.json"),
      JSON.stringify({
        sourceId: "trusted",
        verifiedAt: "2026-09-13T12:00:00Z",
        events: [{
          ...importedEvent,
          organizerId: "linda-skjoennemand",
          organizerName: "Linda Skjønnemand",
        }],
      }),
    );

    expect((await loadRepository(root)).events[0]).toMatchObject({
      organizerId: "linda-skjoennemand",
      organizerName: "Linda Skjønnemand",
    });
  });

  it("uses a fixed twelve-month expansion window", async () => {
    const root = await fixtureRoot();
    await fs.writeFile(path.join(root, "data/imported/trusted.json"), JSON.stringify({
      sourceId: "trusted",
      verifiedAt: "2026-09-13T12:00:00Z",
      events: [importedEvent],
    }));
    const resolved = await resolvePublicData(root, DateTime.fromISO("2026-09-13T12:00:00", { zone: CALENDAR_ZONE }));
    expect(resolved.metadata.rangeStart).toBe("2026-08-13");
    expect(resolved.metadata.rangeEnd).toBe("2027-09-13");
    expect(resolved.occurrences).toHaveLength(1);
  });
});
