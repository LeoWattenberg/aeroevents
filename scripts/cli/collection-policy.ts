import type { EventRecord, SourceDefinition as RepositorySource } from "../../src/lib/schema.js";
import type { PublicationDisposition } from "../sources/types.js";

export function eventSourceIdentity(event: EventRecord): string {
  return `${event.source.sourceId}:${event.source.externalId || event.id}`;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("da-DK")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstEventDate(event: EventRecord): { date: string; time: string } {
  const item = event.schedule.kind === "explicit" ? event.schedule.dates[0] : event.schedule.dtstart;
  if (!item) return { date: "", time: "" };
  return { date: item.date, time: item.kind === "timed" ? item.startTime : item.kind };
}

export function eventFingerprint(event: EventRecord): string {
  const when = firstEventDate(event);
  return [normalizeText(event.title), when.date, when.time].join("|");
}

/** Return duplicate explanations for every candidate, including all sides of a same-run match. */
export function crossSourceDuplicateReasons(
  existingEvents: EventRecord[],
  candidates: EventRecord[],
): Map<string, string[]> {
  const groups = new Map<string, EventRecord[]>();
  for (const event of [...existingEvents, ...candidates]) {
    const fingerprint = eventFingerprint(event);
    groups.set(fingerprint, [...(groups.get(fingerprint) || []), event]);
  }

  const reasons = new Map<string, string[]>();
  for (const candidate of candidates) {
    const duplicates = (groups.get(eventFingerprint(candidate)) || []).filter(
      (other) => other.source.sourceId !== candidate.source.sourceId,
    );
    if (!duplicates.length) continue;
    reasons.set(
      eventSourceIdentity(candidate),
      [...new Set(duplicates.map((other) => `Mulig dublet af ${other.id} fra ${other.source.sourceId}`))],
    );
  }
  return reasons;
}

export interface CandidatePolicyResult {
  publication: "published" | "draft";
  reasons: string[];
  editorOwned: boolean;
}

export type ReviewQueueOutcome = "created" | "updated" | "already-pending" | "approved" | "rejected";
export type ReviewSnapshotAction = "observe-draft" | "retain-demoted" | "remove";

export function reviewSnapshotAction(
  editorOwned: boolean,
  queueOutcome: ReviewQueueOutcome,
  hasPublicationOverride = false,
): ReviewSnapshotAction {
  if (editorOwned) return "remove";
  // Only a newly queued base or the exact payload recorded by an approval may
  // replace the snapshot. Repeated pending and rejected payloads must retain
  // the old base, especially when a publication override exists in Git but
  // private decision state has been lost.
  if (queueOutcome === "approved") return "observe-draft";
  if (hasPublicationOverride || queueOutcome !== "created") return "retain-demoted";
  return "observe-draft";
}

/** Apply editor-controlled defaults before reference validation and persistence. */
export function applySourceMappings(event: EventRecord, source: RepositorySource): EventRecord {
  return {
    ...event,
    ...(source.organizerId ? { organizerId: source.organizerId } : {}),
    ...(source.categoryIds.length ? { categoryIds: [...source.categoryIds] } : {}),
  };
}

/**
 * Adapter disposition can require review, but only data/sources.yaml can grant
 * automatic publication. This is the final gate before snapshot persistence.
 */
export function applyCollectionPolicy(
  source: RepositorySource,
  adapterDisposition: PublicationDisposition,
  duplicateReasons: string[],
  editorOwned: boolean,
  rejected: boolean = false,
): CandidatePolicyResult {
  const reasons = [...duplicateReasons];
  if (!source.enabled) reasons.push("Kilden er deaktiveret i data/sources.yaml");
  if (source.publication !== "automatic") {
    reasons.push("Kilden kræver godkendelse ifølge data/sources.yaml");
  }
  if (adapterDisposition === "review") reasons.push("Kildeadapteren kræver redaktionel kontrol");
  if (editorOwned) reasons.push("En tidligere godkendt manuel post ejer dette kilde-id");
  if (rejected) reasons.push("Kilde-id'et er tidligere afvist af redaktøren");

  return {
    publication:
      source.enabled &&
      source.publication === "automatic" &&
      adapterDisposition === "trusted" &&
      duplicateReasons.length === 0 &&
      !editorOwned &&
      !rejected
        ? "published"
        : "draft",
    reasons: [...new Set(reasons)],
    editorOwned,
  };
}
