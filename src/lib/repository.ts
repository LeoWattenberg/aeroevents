import { promises as fs } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { parse as parseYaml } from "yaml";
import {
  buildMetadataSchema,
  categorySchema,
  eventOverrideSchema,
  eventSchema,
  importedSnapshotSchema,
  organizerSchema,
  sourceDefinitionSchema,
  type BuildMetadata,
  type Category,
  type EventOverride,
  type EventRecord,
  type ImportedSnapshot,
  type Occurrence,
  type Organizer,
  type SourceDefinition,
} from "./schema";
import { CALENDAR_ZONE, expandEvents } from "./schedule";

export interface RepositoryData {
  categories: Category[];
  organizers: Organizer[];
  sources: SourceDefinition[];
  events: EventRecord[];
  snapshots: ImportedSnapshot[];
  overrides: EventOverride[];
}

export interface PublicData extends RepositoryData {
  publicEvents: EventRecord[];
  occurrences: Occurrence[];
  metadata: BuildMetadata;
}

async function readStructuredFile(file: string): Promise<unknown> {
  const source = await fs.readFile(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
}

async function existingFiles(directory: string, extensions: string[]): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function parseMany<T>(files: string[], parser: { parse(value: unknown): T }): Promise<T[]> {
  const values: T[] = [];
  for (const file of files) {
    try {
      values.push(parser.parse(await readStructuredFile(file)));
    } catch (error) {
      throw new Error(`${path.relative(process.cwd(), file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

async function parseOverrides(files: string[]): Promise<EventOverride[]> {
  const values: EventOverride[] = [];
  for (const file of files) {
    try {
      const raw = await readStructuredFile(file);
      const parsed = eventOverrideSchema.parse(raw);
      const rawSet =
        raw && typeof raw === "object" && "set" in raw && raw.set && typeof raw.set === "object"
          ? (raw.set as Record<string, unknown>)
          : {};
      // Some referenced field schemas have defaults. Preserve the actual YAML
      // key set so an omitted field never becomes an accidental override.
      parsed.set = Object.fromEntries(
        Object.entries(parsed.set).filter(([key]) => Object.hasOwn(rawSet, key)),
      ) as EventOverride["set"];
      values.push(parsed);
    } catch (error) {
      throw new Error(`${path.relative(process.cwd(), file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

function applyOverride(event: EventRecord, override: EventOverride): EventRecord {
  const patch = override.set;
  const merged: Record<string, unknown> = { ...event, ...patch };
  if (patch.location === null) delete merged.location;
  if (patch.price === null) delete merged.price;
  if (patch.booking === null) delete merged.booking;
  return eventSchema.parse(merged);
}

function assertUnique<T>(items: T[], label: string, getId: (item: T) => string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const itemId = getId(item);
    if (seen.has(itemId)) throw new Error(`Dubleret ${label}: ${itemId}`);
    seen.add(itemId);
  }
}

export async function loadRepository(root = process.cwd()): Promise<RepositoryData> {
  const dataRoot = path.join(root, "data");
  const [rawCategories, rawOrganizers, rawSources, manualFiles, overrideFiles, importedFiles] = await Promise.all([
    readStructuredFile(path.join(dataRoot, "categories.yaml")),
    readStructuredFile(path.join(dataRoot, "organizers.yaml")),
    readStructuredFile(path.join(dataRoot, "sources.yaml")),
    existingFiles(path.join(dataRoot, "manual", "events"), [".yaml", ".yml"]),
    existingFiles(path.join(dataRoot, "overrides"), [".yaml", ".yml"]),
    existingFiles(path.join(dataRoot, "imported"), [".json"]),
  ]);

  const categories = categorySchema.array().parse(rawCategories);
  const organizers = organizerSchema.array().parse(rawOrganizers);
  const sources = sourceDefinitionSchema.array().parse(rawSources);
  const manualEvents = await parseMany(manualFiles, eventSchema);
  const overrides = await parseOverrides(overrideFiles);
  const snapshots = await parseMany(importedFiles, importedSnapshotSchema);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const importedEvents = snapshots.flatMap((snapshot) =>
    snapshot.events.map((event) => {
      const source = sourceById.get(snapshot.sourceId);
      return eventSchema.parse({
        ...event,
        ...(source?.categoryIds.length ? { categoryIds: source.categoryIds } : {}),
        // A source configured for review cannot grant itself publication by
        // storing a published event. An explicit editorial override may still
        // publish it after this gate is applied.
        publication: source?.publication === "automatic" ? event.publication : "draft",
        source: {
          ...event.source,
          sourceId: snapshot.sourceId,
          // Snapshot verification describes the source as a whole. Preserve a
          // retained event's own last-seen value across later source checks.
          verifiedAt: event.source.verifiedAt ?? snapshot.verifiedAt,
        },
      });
    }),
  );

  assertUnique(categories, "kategori-id", (item) => item.id);
  assertUnique(organizers, "arrangør-id", (item) => item.id);
  assertUnique(sources, "kilde-id", (item) => item.id);
  assertUnique(snapshots, "kildesnapshot", (item) => item.sourceId);

  const byId = new Map<string, EventRecord>();
  for (const event of [...manualEvents, ...importedEvents]) {
    if (byId.has(event.id)) throw new Error(`Dubleret event-id: ${event.id}`);
    byId.set(event.id, event);
  }

  for (const override of overrides) {
    const event = byId.get(override.eventId);
    if (!event) throw new Error(`Override peger på ukendt event: ${override.eventId}`);
    byId.set(event.id, applyOverride(event, override));
  }

  const organizerIds = new Set(organizers.map((item) => item.id));
  const categoryIds = new Set(categories.map((item) => item.id));
  const sourceIds = new Set(sources.map((item) => item.id));
  for (const event of byId.values()) {
    if (!organizerIds.has(event.organizerId)) throw new Error(`${event.id}: Ukendt arrangør ${event.organizerId}`);
    for (const categoryId of event.categoryIds) {
      if (!categoryIds.has(categoryId)) throw new Error(`${event.id}: Ukendt kategori ${categoryId}`);
    }
    if (!sourceIds.has(event.source.sourceId)) throw new Error(`${event.id}: Ukendt kilde ${event.source.sourceId}`);
  }
  for (const source of sources) {
    if (source.organizerId && !organizerIds.has(source.organizerId)) {
      throw new Error(`${source.id}: Ukendt standardarrangør ${source.organizerId}`);
    }
    for (const categoryId of source.categoryIds) {
      if (!categoryIds.has(categoryId)) throw new Error(`${source.id}: Ukendt standardkategori ${categoryId}`);
    }
  }

  return { categories, organizers, sources, events: [...byId.values()], snapshots, overrides };
}

export async function resolvePublicData(
  root = process.cwd(),
  now: DateTime<boolean> = DateTime.now().setZone(CALENDAR_ZONE),
  options: { includeDrafts?: boolean } = {},
): Promise<PublicData> {
  const repository = await loadRepository(root);
  const publicEvents = repository.events.filter(
    (event) => event.publication === "published" || options.includeDrafts === true,
  );
  const rangeStart = now.startOf("day").minus({ days: 31 });
  const rangeEnd = now.startOf("day").plus({ months: 12 });
  const expansion = expandEvents(publicEvents, rangeStart, rangeEnd);
  const metadata = buildMetadataSchema.parse({
    generatedAt: now.toUTC().toISO(),
    rangeStart: rangeStart.toISODate(),
    rangeEnd: rangeEnd.toISODate(),
    sources: repository.sources.map((source) => {
      const snapshot = repository.snapshots.find((item) => item.sourceId === source.id);
      return {
        sourceId: source.id,
        ...(snapshot ? { verifiedAt: snapshot.verifiedAt, eventCount: snapshot.events.length } : { eventCount: 0 }),
      };
    }),
    warnings: expansion.warnings,
  });
  return { ...repository, publicEvents, occurrences: expansion.occurrences, metadata };
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export async function writeGeneratedData(
  root = process.cwd(),
  now?: DateTime<boolean>,
  options: { includeDrafts?: boolean } = {},
): Promise<PublicData> {
  const data = await resolvePublicData(root, now, options);
  const generated = path.join(root, "data", "generated");
  await Promise.all([
    atomicJson(path.join(generated, "events.json"), data.publicEvents),
    atomicJson(path.join(generated, "occurrences.json"), data.occurrences),
    atomicJson(path.join(generated, "organizers.json"), data.organizers),
    atomicJson(path.join(generated, "categories.json"), data.categories),
    atomicJson(path.join(generated, "sources.json"), data.sources),
    atomicJson(path.join(generated, "metadata.json"), [data.metadata]),
  ]);
  return data;
}
