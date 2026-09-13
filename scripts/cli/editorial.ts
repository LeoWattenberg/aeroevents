import type { EventOverride, EventRecord } from "../../src/lib/schema.js";
import { digest } from "./files.js";

/** Build the smallest persistent correction; unchanged source fields stay live. */
export function buildApprovalOverride(event: EventRecord, importedBase: EventRecord): EventOverride {
  const set: Record<string, unknown> = { publication: "published" };
  for (const key of [
    "title",
    "description",
    "organizerId",
    "categoryIds",
    "attendance",
    "status",
    "schedule",
  ] as const) {
    if (digest(importedBase[key]) !== digest(event[key])) set[key] = event[key];
  }
  for (const key of ["location", "price", "booking"] as const) {
    if (digest(importedBase[key]) !== digest(event[key])) set[key] = event[key] ?? null;
  }
  // Values come from already validated EventRecords and the key list above is
  // closed. Avoid parsing here because defaulted event fields inside the Zod
  // override shape would turn omitted fields into unintended corrections.
  return { eventId: event.id, set } as EventOverride;
}
