import type { EventRecord, Occurrence } from "../../src/lib/schema.js";

export const DEFAULT_TITLE_SIMILARITY = 0.6;
export const DEFAULT_TIME_TOLERANCE_MINUTES = 30;
const STRONG_TITLE_SIMILARITY = 0.78;

export interface DuplicateEventReference {
  id: string;
  title: string;
  sourceId: string;
  publication: EventRecord["publication"];
  location?: string;
  url?: string;
}

export interface DuplicateSharedStart {
  date: string;
  leftTime: string;
  rightTime: string;
  differenceMinutes?: number;
}

export interface EventDuplicateMatch {
  left: DuplicateEventReference;
  right: DuplicateEventReference;
  titleSimilarity: number;
  sharedStarts: DuplicateSharedStart[];
}

export interface DuplicateFinderOptions {
  minimumTitleSimilarity?: number;
  timeToleranceMinutes?: number;
}

function normalizeTitle(value: string): string {
  return value
    .toLocaleLowerCase("da-DK")
    .replace(/&/g, " og ")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function diceCoefficient(left: readonly string[], right: readonly string[]): number {
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;

  const available = new Map<string, number>();
  for (const item of right) available.set(item, (available.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of left) {
    const count = available.get(item) || 0;
    if (!count) continue;
    intersection += 1;
    available.set(item, count - 1);
  }
  return (2 * intersection) / (left.length + right.length);
}

function characterBigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

/** A deterministic 0..1 similarity score that tolerates word order, additions and small typos. */
export function titleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);
  if (normalizedLeft === normalizedRight) return normalizedLeft ? 1 : 0;

  const leftTokens = [...new Set(normalizedLeft.split(" ").filter(Boolean))];
  const rightTokens = [...new Set(normalizedRight.split(" ").filter(Boolean))];
  const tokenDice = diceCoefficient(leftTokens, rightTokens);
  const characterDice = diceCoefficient(characterBigrams(normalizedLeft), characterBigrams(normalizedRight));

  const rightSet = new Set(rightTokens);
  const commonTokens = leftTokens.filter((token) => rightSet.has(token)).length;
  const shorterLength = Math.min(leftTokens.length, rightTokens.length);
  const longerLength = Math.max(leftTokens.length, rightTokens.length);
  // A meaningful multi-word title contained in a longer title is a strong
  // signal (for example "Johnny Hansen" and "Koncert med Johnny Hansen").
  const containment =
    shorterLength >= 2 && commonTokens === shorterLength
      ? 0.8 + 0.2 * (shorterLength / longerLength)
      : 0;

  return Math.max(tokenDice, characterDice, containment);
}

function occurrenceTime(occurrence: Occurrence): { label: string; minutes?: number; kind: "timed" | "unknown" | "all-day" } {
  if (occurrence.allDay) return { label: "hele dagen", kind: "all-day" };
  if (occurrence.timeUnknown || !occurrence.startAt) return { label: "ukendt tid", kind: "unknown" };
  const match = occurrence.startAt.match(/T(\d{2}):(\d{2})/);
  if (!match) return { label: "ukendt tid", kind: "unknown" };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return { label: `${match[1]}:${match[2]}`, minutes: hours * 60 + minutes, kind: "timed" };
}

function compatibleStart(
  left: Occurrence,
  right: Occurrence,
  tolerance: number,
): DuplicateSharedStart | undefined {
  const leftTime = occurrenceTime(left);
  const rightTime = occurrenceTime(right);
  if (leftTime.kind === "all-day" || rightTime.kind === "all-day") {
    if (leftTime.kind !== rightTime.kind && leftTime.kind !== "unknown" && rightTime.kind !== "unknown") {
      return undefined;
    }
  }

  let differenceMinutes: number | undefined;
  if (leftTime.minutes !== undefined && rightTime.minutes !== undefined) {
    differenceMinutes = Math.abs(leftTime.minutes - rightTime.minutes);
    if (differenceMinutes > tolerance) return undefined;
  }
  return {
    date: left.date,
    leftTime: leftTime.label,
    rightTime: rightTime.label,
    ...(differenceMinutes !== undefined ? { differenceMinutes } : {}),
  };
}

function eventReference(event: EventRecord): DuplicateEventReference {
  return {
    id: event.id,
    title: event.title,
    sourceId: event.source.sourceId,
    publication: event.publication,
    ...(event.location?.name ? { location: event.location.name } : {}),
    ...(event.source.url ? { url: event.source.url } : {}),
  };
}

function normalizedLocations(left: EventRecord, right: EventRecord): [string, string] | undefined {
  const leftLocation = left.location?.name;
  const rightLocation = right.location?.name;
  if (!leftLocation || !rightLocation) return undefined;
  return [normalizeTitle(leftLocation), normalizeTitle(rightLocation)];
}

function locationsExactlyAgree(left: EventRecord, right: EventRecord): boolean {
  const locations = normalizedLocations(left, right);
  return locations !== undefined && locations[0] === locations[1];
}

function locationsConflict(left: EventRecord, right: EventRecord): boolean {
  const locations = normalizedLocations(left, right);
  return locations !== undefined && titleSimilarity(locations[0], locations[1]) < 0.9;
}

function sharedStartKey(start: DuplicateSharedStart): string {
  return `${start.date}|${start.leftTime}|${start.rightTime}`;
}

/** Find likely duplicate event pairs among already-expanded calendar occurrences. */
export function findEventDuplicates(
  events: EventRecord[],
  occurrences: Occurrence[],
  options: DuplicateFinderOptions = {},
): EventDuplicateMatch[] {
  const threshold = options.minimumTitleSimilarity ?? DEFAULT_TITLE_SIMILARITY;
  const tolerance = options.timeToleranceMinutes ?? DEFAULT_TIME_TOLERANCE_MINUTES;
  if (threshold < 0 || threshold > 1) throw new Error("Titelgrænsen skal være mellem 0 og 1.");
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Tidstolerancen skal være mindst 0 minutter.");

  const eventById = new Map(events.map((event) => [event.id, event]));
  const occurrencesByDate = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    if (!eventById.has(occurrence.eventId)) continue;
    occurrencesByDate.set(occurrence.date, [...(occurrencesByDate.get(occurrence.date) || []), occurrence]);
  }

  const matches = new Map<string, EventDuplicateMatch>();
  for (const dateOccurrences of occurrencesByDate.values()) {
    for (let leftIndex = 0; leftIndex < dateOccurrences.length; leftIndex += 1) {
      const firstOccurrence = dateOccurrences[leftIndex];
      if (!firstOccurrence) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < dateOccurrences.length; rightIndex += 1) {
        const secondOccurrence = dateOccurrences[rightIndex];
        if (!secondOccurrence || firstOccurrence.eventId === secondOccurrence.eventId) continue;

        const firstEvent = eventById.get(firstOccurrence.eventId);
        const secondEvent = eventById.get(secondOccurrence.eventId);
        if (!firstEvent || !secondEvent) continue;
        const similarity = titleSimilarity(firstEvent.title, secondEvent.title);
        if (similarity < threshold) continue;
        // Moderately similar titles need corroboration from the venue. Strong
        // title matches stand on their own, including records with no venue.
        if (similarity < STRONG_TITLE_SIMILARITY && !locationsExactlyAgree(firstEvent, secondEvent)) continue;
        if (similarity < 1 && locationsConflict(firstEvent, secondEvent)) continue;

        const firstComesFirst = firstEvent.id.localeCompare(secondEvent.id, "da-DK") <= 0;
        const leftEvent = firstComesFirst ? firstEvent : secondEvent;
        const rightEvent = firstComesFirst ? secondEvent : firstEvent;
        const leftOccurrence = firstComesFirst ? firstOccurrence : secondOccurrence;
        const rightOccurrence = firstComesFirst ? secondOccurrence : firstOccurrence;
        const start = compatibleStart(leftOccurrence, rightOccurrence, tolerance);
        if (!start) continue;

        const key = `${leftEvent.id}\u0000${rightEvent.id}`;
        const existing = matches.get(key);
        if (existing) {
          if (!existing.sharedStarts.some((item) => sharedStartKey(item) === sharedStartKey(start))) {
            existing.sharedStarts.push(start);
          }
        } else {
          matches.set(key, {
            left: eventReference(leftEvent),
            right: eventReference(rightEvent),
            titleSimilarity: Number(similarity.toFixed(3)),
            sharedStarts: [start],
          });
        }
      }
    }
  }

  return [...matches.values()]
    .map((match) => ({
      ...match,
      sharedStarts: match.sharedStarts.sort((left, right) =>
        `${left.date}|${left.leftTime}|${left.rightTime}`.localeCompare(
          `${right.date}|${right.leftTime}|${right.rightTime}`,
        ),
      ),
    }))
    .sort((left, right) => {
      const dateOrder = (left.sharedStarts[0]?.date || "").localeCompare(right.sharedStarts[0]?.date || "");
      return dateOrder || left.left.id.localeCompare(right.left.id, "da-DK") || left.right.id.localeCompare(right.right.id, "da-DK");
    });
}
