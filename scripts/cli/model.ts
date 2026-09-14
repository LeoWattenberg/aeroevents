import type { NormalizedEventDraft } from "../sources/types.js";
import { safeId } from "./files.js";
import {
  eventDateSchema,
  eventSchema,
  importedSnapshotSchema,
  type EventRecord,
  type ImportedSnapshot,
} from "../../src/lib/schema.js";
import { loadRepository, resolvePublicData } from "../../src/lib/repository.js";

function occurrenceToDate(occurrence: NormalizedEventDraft["occurrences"][number]) {
  const identity = {
    id: occurrence.id,
    date: occurrence.date,
    ...(occurrence.status ? { status: occurrence.status } : {}),
    ...(occurrence.location ? { location: occurrence.location } : {}),
  };
  if (occurrence.allDay) {
    return eventDateSchema.parse({
      ...identity,
      kind: "all-day",
      ...(occurrence.endDate ? { endDate: occurrence.endDate } : {}),
    });
  }
  if (occurrence.timeUnknown || !occurrence.startTime) {
    return eventDateSchema.parse({
      ...identity,
      kind: "time-unknown",
    });
  }
  return eventDateSchema.parse({
    ...identity,
    kind: "timed",
    startTime: occurrence.startTime,
    ...(occurrence.endTime
      ? { endTime: occurrence.endTime, ...(occurrence.endDate ? { endDate: occurrence.endDate } : {}) }
      : {}),
  });
}

export function sourceDraftToEvent(draft: NormalizedEventDraft): EventRecord {
  return eventSchema.parse({
    id: safeId(draft.stableId),
    title: draft.title,
    description: draft.description || "",
    organizerId: draft.organizerId,
    ...(draft.organizerName ? { organizerName: draft.organizerName } : {}),
    categoryIds: draft.categoryIds,
    ...(draft.location?.name ? { location: draft.location } : {}),
    attendance:
      draft.attendance === "members"
        ? { kind: "members", ...(draft.attendanceDetails ? { details: draft.attendanceDetails } : {}) }
        : draft.attendance === "registration"
          ? {
              kind: "registration",
              ...(draft.attendanceDetails ? { details: draft.attendanceDetails } : {}),
            }
        : draft.attendance === "unknown"
          ? {
              kind: "public",
              details: draft.attendanceDetails || "Adgangsforhold er ikke bekræftet.",
            }
          : { kind: "public", ...(draft.attendanceDetails ? { details: draft.attendanceDetails } : {}) },
    status: draft.status,
    publication: draft.publication === "trusted" ? "published" : "draft",
    ...(draft.price ? { price: draft.price } : {}),
    ...(draft.bookingUrl || draft.bookingRequired !== undefined || draft.bookingDetails || draft.availability === "sold-out"
      ? {
          booking: {
            required: draft.bookingRequired ?? false,
            soldOut: draft.availability === "sold-out",
            ...(draft.bookingUrl ? { url: draft.bookingUrl } : {}),
            ...(draft.bookingDetails ? { details: draft.bookingDetails } : {}),
          },
        }
      : {}),
    schedule: { kind: "explicit", dates: draft.occurrences.map(occurrenceToDate) },
    source: {
      sourceId: draft.sourceId,
      externalId: draft.sourceEventId,
      url: draft.provenance.sourceUrl,
      verifiedAt: draft.provenance.retrievedAt,
      ...(draft.provenance.sourceModifiedAt
        ? { modifiedAt: draft.provenance.sourceModifiedAt }
        : {}),
    },
  });
}

export function validateEvent(value: unknown): EventRecord {
  return eventSchema.parse(value);
}

export function validateSnapshot(value: unknown): ImportedSnapshot {
  return importedSnapshotSchema.parse(value);
}

export async function validateAllPublicData(root: string) {
  const repository = await loadRepository(root);
  const publicData = await resolvePublicData(root);
  return { repository, publicData };
}

export async function assertEventReferences(root: string, event: EventRecord): Promise<void> {
  const repository = await loadRepository(root);
  if (!event.organizerName && !repository.organizers.some((item) => item.id === event.organizerId)) {
    throw new Error(`Ukendt arrangør: ${event.organizerId}`);
  }
  for (const categoryId of event.categoryIds) {
    if (!repository.categories.some((item) => item.id === categoryId)) {
      throw new Error(`Ukendt kategori: ${categoryId}`);
    }
  }
  if (!repository.sources.some((item) => item.id === event.source.sourceId)) {
    throw new Error(`Ukendt kilde: ${event.source.sourceId}`);
  }
}
