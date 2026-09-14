import type { EventRecord } from "../../src/lib/schema.js";

export function snapshotSourceIdentity(event: EventRecord): string {
  return event.source.externalId || event.id;
}

/**
 * Public event IDs are URLs and override targets. Once a source identity has
 * been imported, keep that established ID even if slug generation improves.
 */
export function preserveSnapshotEventId(
  previousEvents: EventRecord[],
  observedEvent: EventRecord,
): EventRecord {
  const identity = snapshotSourceIdentity(observedEvent);
  const previous = previousEvents.find(
    (event) => snapshotSourceIdentity(event) === identity,
  );
  return previous && previous.id !== observedEvent.id
    ? { ...observedEvent, id: previous.id }
    : observedEvent;
}

export interface SnapshotMergeOptions {
  /** Identities represented by editor-owned manual records must leave the snapshot. */
  removeIdentities?: ReadonlySet<string>;
  /** Invalid observed records are retained only as non-public bases for later review. */
  demoteIdentities?: ReadonlySet<string>;
  /** A review-only source policy demotes all retained records as a final safety gate. */
  demoteAllRetained?: boolean;
  /** Authoritative feeds retire unobserved records unless an invalid/review transition must retain them. */
  retainUnobserved?: boolean;
  /** Backfill an old snapshot once so later checks cannot look like its last-seen time. */
  previousVerifiedAt?: string;
}

/**
 * A complete source response may cover a smaller window than an earlier one.
 * Replace records explicitly observed under the same source identity and keep
 * every other previous record until a source explicitly changes its status.
 */
export function mergeSourceEvents(
  previousEvents: EventRecord[],
  observedEvents: EventRecord[],
  options: SnapshotMergeOptions = {},
): EventRecord[] {
  const replacements = new Map<string, EventRecord>();
  for (const event of observedEvents) {
    const identity = snapshotSourceIdentity(event);
    if (replacements.has(identity)) {
      throw new Error(`Kilden returnerede samme eksterne event-id flere gange: ${identity}`);
    }
    replacements.set(identity, event);
  }
  const retained = previousEvents
    .filter((event) => {
      const identity = snapshotSourceIdentity(event);
      return (
        !replacements.has(identity) &&
        !options.removeIdentities?.has(identity) &&
        (options.retainUnobserved !== false || options.demoteIdentities?.has(identity))
      );
    })
    .map((event) => {
      const retainedEvent =
        !event.source.verifiedAt && options.previousVerifiedAt
          ? {
              ...event,
              source: { ...event.source, verifiedAt: options.previousVerifiedAt },
            }
          : event;
      const shouldDemote =
        options.demoteAllRetained || options.demoteIdentities?.has(snapshotSourceIdentity(event));
      return shouldDemote && retainedEvent.publication !== "draft"
        ? ({ ...retainedEvent, publication: "draft" } satisfies EventRecord)
        : retainedEvent;
    });
  return [...retained, ...observedEvents];
}
