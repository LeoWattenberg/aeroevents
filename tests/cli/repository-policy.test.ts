import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { loadRepository, resolvePublicData } from "../../src/lib/repository";
import { CALENDAR_ZONE } from "../../src/lib/schedule";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aeroevents-policy-"));
  temporaryDirectories.push(root);
  await Promise.all([
    mkdir(join(root, "data/manual/events"), { recursive: true }),
    mkdir(join(root, "data/imported"), { recursive: true }),
    mkdir(join(root, "data/overrides"), { recursive: true }),
  ]);
  await writeFile(join(root, "data/categories.yaml"), toYaml([
    { id: "yaml-category", name: "YAML-kategori", color: "#123456" },
    { id: "adapter-category", name: "Adapterkategori", color: "#654321" },
  ]));
  await writeFile(join(root, "data/organizers.yaml"), toYaml([
    { id: "yaml-organizer", name: "YAML-arrangør" },
    { id: "adapter-organizer", name: "Adapterarrangør" },
  ]));
  return root;
}

function source(publication: "automatic" | "review") {
  return [{
    id: "source-a",
    name: "Kilde A",
    organizerId: "yaml-organizer",
    categoryIds: ["yaml-category"],
    publication,
    enabled: true,
  }];
}

function importedEvent(title: string, verifiedAt?: string) {
  return {
    id: "source-a-one",
    title,
    organizerId: "adapter-organizer",
    categoryIds: ["adapter-category"],
    publication: "published",
    schedule: {
      kind: "explicit",
      dates: [{ kind: "timed", date: "2026-11-04", startTime: "19:00" }],
    },
    source: {
      sourceId: "source-a",
      externalId: "one",
      ...(verifiedAt ? { verifiedAt } : {}),
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("repository source policy", () => {
  it("gates imported publication and mappings through YAML before applying an override", async () => {
    const root = await fixture();
    const eventSeenAt = "2026-09-10T10:00:00Z";
    const sourceCheckedAt = "2026-09-13T12:00:00Z";
    await writeFile(join(root, "data/sources.yaml"), toYaml(source("review")));
    await writeFile(join(root, "data/imported/source-a.json"), JSON.stringify({
      sourceId: "source-a",
      verifiedAt: sourceCheckedAt,
      events: [importedEvent("Første titel", eventSeenAt)],
    }));

    const gated = await loadRepository(root);
    expect(gated.events[0]).toMatchObject({
      publication: "draft",
      organizerId: "adapter-organizer",
      categoryIds: ["yaml-category"],
      source: { verifiedAt: eventSeenAt },
    });
    const hidden = await resolvePublicData(
      root,
      DateTime.fromISO("2026-09-13T12:00:00", { zone: CALENDAR_ZONE }),
    );
    expect(hidden.publicEvents).toEqual([]);
    expect(hidden.metadata.sources[0]?.verifiedAt).toBe(sourceCheckedAt);

    await writeFile(
      join(root, "data/overrides/source-a-one.yaml"),
      toYaml({ eventId: "source-a-one", set: { publication: "published" } }),
    );
    const approved = await resolvePublicData(
      root,
      DateTime.fromISO("2026-09-13T12:00:00", { zone: CALENDAR_ZONE }),
    );
    expect(approved.publicEvents).toHaveLength(1);

    // When the adapter later trusts the same source identity, the snapshot base
    // is replaced in place and the publication-only override does not freeze it.
    await writeFile(join(root, "data/sources.yaml"), toYaml(source("automatic")));
    await writeFile(join(root, "data/imported/source-a.json"), JSON.stringify({
      sourceId: "source-a",
      verifiedAt: "2026-09-14T12:00:00Z",
      events: [importedEvent("Ny titel", "2026-09-14T12:00:00Z")],
    }));
    const refreshed = await loadRepository(root);
    expect(refreshed.events).toHaveLength(1);
    expect(refreshed.events[0]).toMatchObject({
      title: "Ny titel",
      publication: "published",
      source: { verifiedAt: "2026-09-14T12:00:00Z" },
    });
  });

  it("falls back to source verification only for legacy events without last-seen time", async () => {
    const root = await fixture();
    await writeFile(join(root, "data/sources.yaml"), toYaml(source("automatic")));
    await writeFile(join(root, "data/imported/source-a.json"), JSON.stringify({
      sourceId: "source-a",
      verifiedAt: "2026-09-13T12:00:00Z",
      events: [importedEvent("Legacy event")],
    }));
    expect((await loadRepository(root)).events[0]?.source.verifiedAt).toBe("2026-09-13T12:00:00Z");
  });

  it("leaves explicitly approved manual records editor-owned", async () => {
    const root = await fixture();
    await writeFile(join(root, "data/sources.yaml"), toYaml(source("review")));
    await writeFile(
      join(root, "data/manual/events/editor-owned.yaml"),
      toYaml(importedEvent("Redaktionens godkendte kopi", "2026-09-10T10:00:00Z")),
    );
    const repository = await loadRepository(root);
    expect(repository.events[0]).toMatchObject({
      publication: "published",
      organizerId: "adapter-organizer",
      categoryIds: ["adapter-category"],
    });
  });
});
