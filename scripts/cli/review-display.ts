import type { ReviewCandidate } from "./review-store.js";
import { recurrenceLabel } from "./recurrence-label.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatDate(value: unknown): string {
  const date = record(value);
  if (!date) return "Ugyldigt tidspunkt";
  const day = text(date.date) || "Ukendt dato";
  const kind = text(date.kind);
  const allDay = kind === "all-day" || date.allDay === true;
  const timeUnknown = kind === "time-unknown" || date.timeUnknown === true;
  if (allDay) {
    const endDate = text(date.endDate);
    return `${day}${endDate && endDate !== day ? `–${endDate}` : ""} (hele dagen)`;
  }
  if (timeUnknown) return `${day} (tidspunkt ukendt)`;

  const startTime = text(date.startTime);
  const endTime = text(date.endTime);
  const endDate = text(date.endDate);
  if (!startTime) return `${day} (tidspunkt ukendt)`;
  if (endDate && endDate !== day) {
    return `${day} kl. ${startTime} – ${endDate}${endTime ? ` kl. ${endTime}` : ""}`;
  }
  return `${day} kl. ${startTime}${endTime ? `–${endTime}` : ""}`;
}

function formatSchedule(event: UnknownRecord): string {
  const schedule = record(event.schedule);
  if (schedule?.kind === "explicit" && Array.isArray(schedule.dates)) {
    return schedule.dates.map(formatDate).join("; ") || "Ikke angivet";
  }
  if (schedule?.kind === "recurring") {
    const friendly = recurrenceLabel(schedule);
    if (friendly) {
      const rule = text(schedule.rrule);
      return `${friendly}${rule ? ` [${rule}]` : ""}`;
    }
    const start = formatDate(schedule.dtstart);
    const rule = text(schedule.rrule);
    return `${start}${rule ? `; gentagelse: ${rule}` : "; gentagende"}`;
  }

  // Invalid source drafts are also retained for review and use occurrences
  // rather than the canonical schedule shape.
  if (Array.isArray(event.occurrences)) {
    return event.occurrences.map(formatDate).join("; ") || "Ikke angivet";
  }
  return "Ikke angivet";
}

function formatLocation(event: UnknownRecord): string {
  const location = record(event.location);
  if (!location) return "Ikke angivet";
  const postalCity = [text(location.postalCode), text(location.city)].filter(Boolean).join(" ");
  const parts = [text(location.name), text(location.address), postalCity || undefined].filter(Boolean);
  return parts.join(", ") || "Ikke angivet";
}

function formatEvidence(candidate: ReviewCandidate): string | undefined {
  const privateData = record(candidate.private);
  const evidence = privateData?.parseEvidence;
  if (!Array.isArray(evidence)) return undefined;
  const snippets = evidence
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  return snippets.length ? `Fundet tekst: ${snippets.join("; ")}` : undefined;
}

export function formatReviewCandidate(
  candidate: ReviewCandidate,
  position: number,
  total: number,
): string {
  const event = record(candidate.event) || {};
  const title = text(event.title) || "Uden titel";
  const reasons = candidate.reasons.length ? candidate.reasons.join("; ") : "Ingen angivet";
  const evidence = formatEvidence(candidate);
  return [
    `Kandidat ${position} af ${total}`,
    `Titel: ${title}`,
    `Tid: ${formatSchedule(event)}`,
    `Sted: ${formatLocation(event)}`,
    `Kilde: ${candidate.sourceUrl}`,
    ...(evidence ? [evidence] : []),
    `Årsag: ${reasons}`,
    `Kandidat-id: ${candidate.candidateId}`,
  ].join("\n");
}

export type ReviewDecision = "approve" | "reject" | "skip";

export function parseReviewDecision(answer: string): ReviewDecision | undefined {
  const normalized = answer.trim().toLowerCase();
  if (["y", "yes", "j", "ja"].includes(normalized)) return "approve";
  if (["n", "no", "nej"].includes(normalized)) return "reject";
  if (["s", "skip", "spring", "spring over"].includes(normalized)) return "skip";
  return undefined;
}
