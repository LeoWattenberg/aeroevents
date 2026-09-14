import { DateTime } from "luxon";

import { errorMessage, fetchText } from "./http";
import { cleanText, deduplicateBy } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import { boundedWeeklySchedule } from "./series-schedule";
import type {
  CollectionContext,
  CollectionResult,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["rise-sif"];
const COPENHAGEN = "Europe/Copenhagen";
const CONVENTUS_ORIGIN = "https://www.conventus.dk";
const BOOKINGS_URL = `${CONVENTUS_ORIGIN}/publicBooking/public/getBookings`;
const ORGANIZATION_ID = 206;
const RESOURCE_NAMES = new Set(["hal", "sal"]);

// Public Conventus calendars can also expose ordinary room reservations. Keep
// this deliberately positive: new activity names must be reviewed in code
// before they become calendar events.
const ALLOWED_TITLES = [
  /^gymnastik\b/i,
  /^badminton\b/i,
  /^yoga med maria$/i,
  /^pilates$/i,
  /^spinning$/i,
  /^aktivitetsdag\b/i,
  /^natminton mesterskab$/i,
  /^rise mesterskab$/i,
];

interface JsonObject {
  [key: string]: unknown;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanText(value);
  return cleaned || undefined;
}

export interface RiseResourceParseResult {
  resourceIds: number[];
  errors: string[];
}

export function parseRiseResources(value: unknown): RiseResourceParseResult {
  const root = object(value);
  const internal = root?.internal;
  const errors: string[] = [];
  if (!Array.isArray(internal)) {
    return { resourceIds: [], errors: ["Conventus-svaret mangler interne ressourcer"] };
  }

  const ids: number[] = [];
  for (const entryValue of internal) {
    const entry = object(entryValue);
    const organization = object(entry?.organization);
    if (integer(organization?.id) !== ORGANIZATION_ID) continue;
    if (!Array.isArray(entry?.resources)) {
      errors.push("Rise SIFs Conventus-post mangler ressourcelisten");
      continue;
    }
    for (const resourceValue of entry.resources) {
      const resource = object(resourceValue);
      const id = integer(resource?.id);
      const name = text(resource?.name)?.toLocaleLowerCase("da-DK");
      if (id !== undefined && name && RESOURCE_NAMES.has(name) && resource?.available !== false) {
        ids.push(id);
      }
    }
  }

  const resourceIds = [...new Set(ids)].sort((left, right) => left - right);
  if (resourceIds.length !== RESOURCE_NAMES.size) {
    errors.push("Fandt ikke både Hal og Sal blandt Rise SIFs offentlige ressourcer");
  }
  return { resourceIds, errors };
}

function occurrence(
  booking: JsonObject,
  bookingId: number,
): ExplicitOccurrenceDraft | undefined {
  const start = integer(booking.start);
  const end = integer(booking.end);
  if (start === undefined || end === undefined || end <= start) return undefined;
  const startAt = DateTime.fromMillis(start, { zone: COPENHAGEN });
  const endAt = DateTime.fromMillis(end, { zone: COPENHAGEN });
  if (!startAt.isValid || !endAt.isValid) return undefined;
  return {
    id: `booking-${bookingId}`,
    date: startAt.toISODate()!,
    startTime: startAt.toFormat("HH:mm"),
    ...(endAt.toISODate() !== startAt.toISODate() ? { endDate: endAt.toISODate()! } : {}),
    endTime: endAt.toFormat("HH:mm"),
    allDay: false,
    timeUnknown: false,
  };
}

export interface RiseBookingParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

export function parseRiseBookings(
  value: unknown,
  resourceIds: number[],
  retrievedAt: string,
): RiseBookingParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const allowedResourceIds = new Set(resourceIds);
  if (!Array.isArray(value)) {
    return { candidates: [], warnings, errors: ["Conventus-bookingerne er ikke en liste"] };
  }

  const grouped = new Map<
    string,
    {
      title: string;
      resourceName?: string;
      occurrences: ExplicitOccurrenceDraft[];
      review: boolean;
    }
  >();

  for (const resourceGroupValue of value) {
    const resourceGroup = object(resourceGroupValue);
    const groupResource = object(resourceGroup?.resource);
    const groupResourceId = integer(groupResource?.id);
    if (groupResourceId === undefined || !allowedResourceIds.has(groupResourceId)) {
      errors.push("Conventus returnerede bookinger for en ikke-valgt ressource");
      continue;
    }
    if (!Array.isArray(resourceGroup?.bookings)) {
      errors.push(`Conventus-ressource ${groupResourceId} mangler bookinglisten`);
      continue;
    }
    for (const bookingValue of resourceGroup.bookings) {
      const booking = object(bookingValue);
      if (!booking) {
        errors.push(`Conventus-ressource ${groupResourceId} indeholder en ugyldig booking`);
        continue;
      }
      const title = text(booking.title);
      if (!title || !ALLOWED_TITLES.some((pattern) => pattern.test(title))) continue;
      const bookingId = integer(booking.id);
      const seriesId = integer(booking.serie);
      if (bookingId === undefined) {
        errors.push(`Den allowlistede Conventus-aktivitet “${title}” mangler booking-id`);
        continue;
      }
      const parsedOccurrence = occurrence(booking, bookingId);
      if (!parsedOccurrence) {
        errors.push(`Conventus-booking ${bookingId} har et ugyldigt tidsinterval`);
        continue;
      }
      const sourceEventId = seriesId === undefined ? `booking-${bookingId}` : `series-${seriesId}`;
      const resource = object(booking.resource);
      const resourceName = text(resource?.name) || text(groupResource?.name);
      const needsReview = /^(?:aktivitetsdag|natminton|rise mesterskab)\b/i.test(title);
      const current = grouped.get(sourceEventId);
      if (current && current.title !== title) {
        errors.push(`Conventus-serie ${sourceEventId} skiftede titel i samme svar`);
        continue;
      }
      if (current) {
        current.occurrences.push(parsedOccurrence);
        current.review ||= needsReview;
      } else {
        grouped.set(sourceEventId, {
          title,
          ...(resourceName ? { resourceName } : {}),
          occurrences: [parsedOccurrence],
          review: needsReview,
        });
      }
    }
  }

  const candidates = [...grouped.entries()]
    .map(([sourceEventId, group]): NormalizedEventDraft => {
      const occurrences = deduplicateBy(
        group.occurrences.sort((left, right) =>
          `${left.date}T${left.startTime}`.localeCompare(`${right.date}T${right.startTime}`),
        ),
        (item) => item.id,
      );
      if (occurrences.length !== group.occurrences.length) {
        warnings.push(`Conventus-serie ${sourceEventId} indeholdt samme booking flere gange`);
      }
      const reviewReasons = group.review
        ? ["Enkeltarrangementets offentlige adgang skal bekræftes"]
        : [];
      const schedule = sourceEventId.startsWith("series-")
        ? boundedWeeklySchedule(occurrences)
        : undefined;
      return {
        sourceId: definition.id,
        sourceEventId,
        stableId: `${definition.id}-${sourceEventId}`,
        title: group.title,
        description: "Aktivitet i Rise Skytte- & Idrætsforenings offentlige aktivitetsplan.",
        organizerId: definition.organizerId,
        categoryIds: [...definition.categoryIds],
        ...(group.resourceName
          ? { location: { name: `Rise Skytte- & Idrætsforening – ${group.resourceName}` } }
          : {}),
        ...(schedule ? { schedule } : {}),
        occurrences,
        status: "scheduled",
        attendance: group.review ? "unknown" : "members",
        attendanceDetails: group.review
          ? "Adgangsforhold skal bekræftes."
          : "Foreningshold; kontakt foreningen om medlemskab og tilmelding.",
        publication: group.review ? "review" : "trusted",
        reviewReasons,
        provenance: {
          sourceId: definition.id,
          externalId: sourceEventId,
          sourceUrl: "https://www.rise-sif.dk/",
          retrievedAt,
        },
      };
    })
    .sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));

  return { candidates, warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}

function scrubBookings(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((groupValue) => {
    const group = object(groupValue);
    if (!group) return groupValue;
    return {
      resource: group.resource,
      bookings: Array.isArray(group.bookings)
        ? group.bookings.map((bookingValue) => {
            const booking = object(bookingValue);
            if (!booking) return bookingValue;
            const {
              bookedBy: _bookedBy,
              bookedByName: _bookedByName,
              bookedTo: _bookedTo,
              lastEditedBy: _lastEditedBy,
              lastEditedByName: _lastEditedByName,
              participants: _participants,
              pin: _pin,
              ...safe
            } = booking;
            return safe;
          })
        : group.bookings,
    };
  });
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  let pagesFetched = 0;
  try {
    const resourcesBody = await fetchText(context, definition.url, {
      expectedOrigin: CONVENTUS_ORIGIN,
      headers: { accept: "application/json" },
    });
    pagesFetched += 1;
    const resources = parseRiseResources(JSON.parse(resourcesBody) as unknown);
    if (resources.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: resources.errors,
        warnings: [],
        discardedCandidateCount: 0,
      };
    }

    const start = DateTime.fromJSDate(context.now, { zone: COPENHAGEN }).startOf("day");
    const end = start.plus({ months: 12 }).endOf("day");
    const { recordResponse: _recordResponse, ...bookingContext } = context;
    const bookingsBody = await fetchText(bookingContext, BOOKINGS_URL, {
      expectedOrigin: CONVENTUS_ORIGIN,
      method: "POST",
      headers: { accept: "application/json" },
      json: {
        organization: { id: ORGANIZATION_ID },
        from: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        to: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        resourceList: resources.resourceIds.map((id) => ({ id })),
        categoryList: [],
        overlap: true,
      },
    });
    pagesFetched += 1;
    const bookingsJson = JSON.parse(bookingsBody) as unknown;
    if (context.recordResponse) {
      await context.recordResponse({
        url: BOOKINGS_URL,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scrubBookings(bookingsJson)),
      });
    }
    const parsed = parseRiseBookings(bookingsJson, resources.resourceIds, retrievedAt);
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: parsed.errors,
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: parsed.candidates,
      errors: [],
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      status: pagesFetched > 0 ? "partial" : "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
      ...(pagesFetched > 0 ? { discardedCandidateCount: 0 } : {}),
    } as CollectionResult;
  }
}

export const riseSifSource: SourceAdapter = { definition, collect };
