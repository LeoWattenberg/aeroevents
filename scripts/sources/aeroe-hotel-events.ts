import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText } from "./html";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  EventStatus,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-hotel-events"];
const HOTEL_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";

/** Stable IDs exposed by this site's Wix Events installation. */
export const WIX_EVENTS_APP_ID = "140603ad-af8d-84a5-2c80-a0f60cb47351";
export const AEROE_HOTEL_META_SITE_ID = "81da065d-53cf-4d56-991b-3817fa31d9c3";
export const AEROE_HOTEL_EVENTS_INSTANCE_ID = "37ec30a9-cf3d-488a-b3d1-746d5ae21606";
export const AEROE_HOTEL_MAX_BODY_BYTES = 3 * 1024 * 1024;
export const AEROE_HOTEL_MAX_WARMUP_BYTES = 1024 * 1024;
export const AEROE_HOTEL_MAX_EVENTS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVIEW_REASON =
  "Kontrollér Wix-eventens tidspunkt mod eventuelle opholdsdatoer samt sted og bookingvilkår.";

interface JsonObject {
  [key: string]: unknown;
}

interface ParsedRegistration {
  attendance: "registration" | "members";
  availability: "available" | "sold-out" | "unknown";
  bookingRequired: true;
  bookingDetails: string;
  reviewReasons: string[];
}

interface ParsedEvent {
  candidate?: NormalizedEventDraft;
  errors: string[];
}

export interface AeroeHotelEventsParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  rawEventCount: number;
  duplicateCount: number;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function scriptJson(
  html: string,
  id: string,
  maxBytes: number,
  errors: string[],
): unknown {
  const $ = load(html);
  const scripts = $(`script#${id}`);
  if (scripts.length !== 1) {
    errors.push(`Wix-siden indeholder ${scripts.length} scripts med id ${id}; forventede ét`);
    return undefined;
  }
  const script = scripts.first();
  if (script.attr("type") !== "application/json") {
    errors.push(`Wix-scriptet ${id} har en uventet content type`);
    return undefined;
  }
  const raw = script.html() ?? "";
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    errors.push(`Wix-scriptet ${id} overstiger grænsen på ${maxBytes} bytes`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    errors.push(`Wix-scriptet ${id} indeholder ugyldig JSON`);
    return undefined;
  }
}

function validateSiteIdentity(essentialValue: unknown, errors: string[]): void {
  const essential = object(essentialValue);
  const site = object(essential?.site);
  if (text(site?.externalBaseUrl) !== HOTEL_ORIGIN) {
    errors.push("Wix-viewermodellen tilhører ikke Ærø Hotels origin");
  }
  const requestUrl = text(essential?.requestUrl);
  if (!requestUrl) {
    errors.push("Wix-viewermodellen mangler requestUrl");
    return;
  }
  try {
    const safe = new URL(sameOriginHttpsUrl(requestUrl, HOTEL_ORIGIN));
    if (!/^\/event-list\/?$/.test(safe.pathname)) {
      errors.push("Wix-viewermodellen er ikke event-list-siden");
    }
  } catch (error) {
    errors.push(`Wix-viewermodellens requestUrl er usikker: ${errorMessage(error)}`);
  }
}

function validateAppInstance(state: JsonObject, label: string, errors: string[]): boolean {
  const instance = object(state.instance);
  const identityErrors: string[] = [];
  if (text(instance?.appDefId) !== WIX_EVENTS_APP_ID) identityErrors.push("appDefId");
  if (text(instance?.metaSiteId) !== AEROE_HOTEL_META_SITE_ID) identityErrors.push("metaSiteId");
  if (text(instance?.instanceId) !== AEROE_HOTEL_EVENTS_INSTANCE_ID) {
    identityErrors.push("instanceId");
  }
  if (instance?.demoMode !== false || instance.siteIsTemplate !== false) {
    identityErrors.push("demo/template-status");
  }
  if (identityErrors.length > 0) {
    errors.push(`Wix-eventstate ${label} har forkert ${identityErrors.join(", ")}`);
    return false;
  }
  const siteSettings = object(state.siteSettings);
  if (
    text(siteSettings?.appState) !== "ENABLED" ||
    text(siteSettings?.language) !== "da"
  ) {
    errors.push(`Wix-eventstate ${label} har uventet app- eller sprogstatus`);
    return false;
  }
  return true;
}

function canonicalEventUrl(slug: string): string {
  if (!EVENT_SLUG.test(slug) || slug.length > 180) {
    throw new Error("eventslug er ugyldigt");
  }
  const value = sameOriginHttpsUrl(`/event-details/${slug}`, HOTEL_ORIGIN);
  const parsed = new URL(value);
  if (parsed.pathname !== `/event-details/${slug}` || parsed.search || parsed.hash) {
    throw new Error("kanonisk eventlink har en uventet form");
  }
  return value;
}

function parseInstant(value: unknown): DateTime | undefined {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.setZone(COPENHAGEN) : undefined;
}

function parseOccurrence(
  eventId: string,
  schedulingValue: unknown,
  errors: string[],
): ExplicitOccurrenceDraft | undefined {
  const scheduling = object(schedulingValue);
  const config = object(scheduling?.config);
  if (!config) {
    errors.push("mangler scheduling.config");
    return undefined;
  }
  if (config.scheduleTbd !== false) errors.push("har ikke et fastlagt tidspunkt");
  if (text(config.timeZoneId) !== COPENHAGEN) errors.push("har en uventet tidszone");
  const recurrences = object(config.recurrences);
  const occurrences = array(recurrences?.occurrences);
  if (occurrences && occurrences.length > 0) {
    errors.push("er tilbagevendende og kan ikke sikkert udledes som én forekomst");
  }

  // scheduling.config is the Wix event interval. Descriptive hotel-stay dates,
  // the rendered formatted strings, and package copy must never replace it.
  const start = parseInstant(config.startDate);
  const end = parseInstant(config.endDate);
  if (!start || !end) {
    errors.push("mangler et gyldigt, zoneangivet start-/sluttidspunkt");
    return undefined;
  }
  if (end <= start) {
    errors.push("slutter ikke efter starttidspunktet");
    return undefined;
  }
  if (errors.length > 0) return undefined;

  return {
    id: `wix-${eventId}`,
    date: start.toISODate()!,
    startTime: start.toFormat("HH:mm"),
    ...(end.toISODate() !== start.toISODate() ? { endDate: end.toISODate()! } : {}),
    endTime: end.toFormat("HH:mm"),
    allDay: false,
    timeUnknown: false,
  };
}

function streetAddress(location: JsonObject, fullAddress: JsonObject | undefined): string | undefined {
  const street = object(fullAddress?.streetAddress);
  if (street) {
    const name = text(street.name);
    const number = text(street.number);
    const apartment = text(street.apt);
    const value = [name, number, apartment].filter(Boolean).join(" ");
    if (value) return value;
  }
  const explicit = text(fullAddress?.addressLine) ?? text(location.address);
  return explicit?.split(",")[0]?.trim() || undefined;
}

function parseLocation(
  value: unknown,
  errors: string[],
  reviewReasons: string[],
): EventLocationDraft | undefined {
  const location = object(value);
  if (!location) {
    errors.push("mangler location");
    return undefined;
  }
  if (location.type !== 0) errors.push("har en uventet ikke-fysisk location.type");
  if (typeof location.tbd !== "boolean") errors.push("mangler en entydig location.tbd-status");
  const name = text(location.name);
  if (!name) errors.push("mangler spillestedsnavn");
  if (!name || errors.length > 0) return undefined;

  if (location.tbd === true) {
    reviewReasons.push("Wix markerer spillestedet som ikke fastlagt.");
    return { name };
  }

  const fullAddress = object(location.fullAddress);
  if (fullAddress && text(fullAddress.country) !== "DK") {
    errors.push("har et spillested uden for Danmark");
    return undefined;
  }
  const address = streetAddress(location, fullAddress);
  const postalCode = text(fullAddress?.postalCode);
  const city = text(fullAddress?.city);
  if (!address || !postalCode || !city) {
    reviewReasons.push("Wix-spillestedets adresse er ufuldstændig.");
  }
  return {
    name,
    ...(address ? { address } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(city ? { city } : {}),
  };
}

function parseEventStatus(value: unknown, errors: string[], reviewReasons: string[]): EventStatus {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3) {
    errors.push("har en ukendt Wix-eventstatus");
    return "scheduled";
  }
  if (value === 1) reviewReasons.push("Wix markerer arrangementet som igangværende.");
  if (value === 2) reviewReasons.push("Wix markerer arrangementet som afsluttet.");
  return value === 3 ? "cancelled" : "scheduled";
}

function parseRegistration(value: unknown, errors: string[]): ParsedRegistration | undefined {
  const registration = object(value);
  if (!registration) {
    errors.push("mangler registration");
    return undefined;
  }
  const type = registration.type;
  if (type !== 1 && type !== 2) {
    errors.push("har en ukendt Wix-registrationstype");
    return undefined;
  }
  const status = registration.status;
  if (!Number.isInteger(status) || typeof status !== "number" || status < 0 || status > 5) {
    errors.push("har en ukendt Wix-registreringsstatus");
    return undefined;
  }
  if (!Number.isInteger(registration.restrictedTo)) {
    errors.push("mangler registration.restrictedTo");
    return undefined;
  }
  const ticketing = object(registration.ticketing);
  const soldOutValue = ticketing?.soldOut;
  if (soldOutValue !== undefined && typeof soldOutValue !== "boolean") {
    errors.push("har en ugyldig ticketing.soldOut-status");
    return undefined;
  }
  const waitlistValue = object(object(registration.rsvpCollection)?.config)?.waitlist;
  if (waitlistValue !== undefined && typeof waitlistValue !== "boolean") {
    errors.push("har en ugyldig ventelistestatus");
    return undefined;
  }

  const reviewReasons: string[] = [];
  if (status !== 1) reviewReasons.push("Wix markerer ikke registreringen som åbent standardflow.");
  if (registration.restrictedTo !== 0) {
    reviewReasons.push("Wix begrænser registreringen til en særlig målgruppe.");
  }
  const kind = type === 2 ? "Billetbestilling" : "Tilmelding";
  const state = soldOutValue === true
    ? "Wix markerer arrangementet som udsolgt."
    : waitlistValue === true
      ? "Wix tilbyder venteliste."
      : status === 1
        ? "Wix markerer registreringen som åben."
        : "Wix markerer ikke registreringen som åben.";
  return {
    attendance: registration.restrictedTo === 0 ? "registration" : "members",
    availability: soldOutValue === true
      ? "sold-out"
      : soldOutValue === false
        ? "available"
        : "unknown",
    bookingRequired: true,
    bookingDetails: `${kind} via Ærø Hotels eventside. ${state}`,
    reviewReasons,
  };
}

function parseWixEvent(value: unknown, retrievedAt: string, index: number): ParsedEvent {
  const errors: string[] = [];
  const event = object(value);
  if (!event) return { errors: [`Wix-eventpost ${index + 1} er ikke et objekt`] };

  const rawId = text(event.id);
  const eventId = rawId?.toLowerCase();
  if (!eventId || !UUID.test(eventId)) errors.push("mangler et gyldigt UUID");
  if (text(event.instanceId) !== AEROE_HOTEL_EVENTS_INSTANCE_ID) {
    errors.push("tilhører en anden Wix Events-instans");
  }
  const title = text(event.title);
  if (!title || title.length > 300) errors.push("mangler en gyldig titel");
  const description = text(event.description);
  if (event.description !== undefined && typeof event.description !== "string") {
    errors.push("har en ugyldig beskrivelse");
  }
  if (description && description.length > 10_000) errors.push("har en for lang beskrivelse");
  const slug = text(event.slug);
  let sourceUrl: string | undefined;
  if (!slug) {
    errors.push("mangler eventslug");
  } else {
    try {
      sourceUrl = canonicalEventUrl(slug);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  if (object(event.eventDisplaySettings)?.hideEventDetailsPage === true) {
    errors.push("har skjult detailside og derfor intet sikkert kanonisk eventlink");
  }

  const reviewReasons = [REVIEW_REASON];
  const localOccurrenceErrors: string[] = [];
  const occurrence = eventId
    ? parseOccurrence(eventId, event.scheduling, localOccurrenceErrors)
    : undefined;
  errors.push(...localOccurrenceErrors);
  const localLocationErrors: string[] = [];
  const location = parseLocation(event.location, localLocationErrors, reviewReasons);
  errors.push(...localLocationErrors);
  const status = parseEventStatus(event.status, errors, reviewReasons);
  const registration = parseRegistration(event.registration, errors);
  if (registration) reviewReasons.push(...registration.reviewReasons);

  let sourceModifiedAt: string | undefined;
  if (event.modified !== undefined) {
    const modified = parseInstant(event.modified);
    if (!modified) errors.push("har et ugyldigt modified-tidspunkt");
    else sourceModifiedAt = modified.toUTC().toISO()!;
  }
  if (
    errors.length > 0 ||
    !eventId ||
    !title ||
    !slug ||
    !sourceUrl ||
    !occurrence ||
    !location ||
    !registration
  ) {
    return { errors: errors.map((error) => `Wix-event ${eventId ?? index + 1} ${error}`) };
  }

  return {
    errors: [],
    candidate: {
      sourceId: definition.id,
      sourceEventId: eventId,
      stableId: `${definition.id}-${eventId}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location,
      occurrences: [occurrence],
      status,
      availability: registration.availability,
      attendance: registration.attendance,
      attendanceDetails: "Wix-opslaget bruger tilmelding eller billetbestilling.",
      bookingUrl: sourceUrl,
      bookingRequired: registration.bookingRequired,
      bookingDetails: registration.bookingDetails,
      publication: "review",
      reviewReasons: [...new Set(reviewReasons)],
      provenance: {
        sourceId: definition.id,
        externalId: eventId,
        sourceUrl,
        retrievedAt,
        ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
      },
    },
  };
}

function candidateSignature(candidate: NormalizedEventDraft): string {
  return JSON.stringify({
    title: candidate.title,
    description: candidate.description,
    location: candidate.location,
    occurrences: candidate.occurrences,
    status: candidate.status,
    availability: candidate.availability,
    attendance: candidate.attendance,
    bookingUrl: candidate.bookingUrl,
    bookingDetails: candidate.bookingDetails,
  });
}

export function parseAeroeHotelEventsPage(
  html: string,
  retrievedAt: string,
): AeroeHotelEventsParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (new TextEncoder().encode(html).byteLength > AEROE_HOTEL_MAX_BODY_BYTES) {
    return {
      candidates: [],
      warnings,
      errors: [`Ærø Hotels HTML overstiger grænsen på ${AEROE_HOTEL_MAX_BODY_BYTES} bytes`],
      rawEventCount: 0,
      duplicateCount: 0,
    };
  }

  const essential = scriptJson(
    html,
    "wix-essential-viewer-model",
    128 * 1024,
    errors,
  );
  validateSiteIdentity(essential, errors);
  const warmup = object(scriptJson(html, "wix-warmup-data", AEROE_HOTEL_MAX_WARMUP_BYTES, errors));
  const apps = object(warmup?.appsWarmupData);
  const wixEventsApp = object(apps?.[WIX_EVENTS_APP_ID]);
  if (!wixEventsApp) {
    errors.push("Wix-warmupdata mangler Ærø Hotels Wix Events-app");
    return { candidates: [], warnings, errors: [...new Set(errors)], rawEventCount: 0, duplicateCount: 0 };
  }

  const rawEvents: unknown[] = [];
  let listingStateCount = 0;
  for (const [label, stateValue] of Object.entries(wixEventsApp)) {
    const state = object(stateValue);
    const collection = object(state?.events);
    const events = array(collection?.events);
    if (!state || !collection || !events) continue;
    listingStateCount += 1;
    validateAppInstance(state, label, errors);
    if (collection.hasMore !== false || collection.moreLoading !== false) {
      errors.push(`Wix-eventstate ${label} er ikke en komplet, afsluttet warmup-liste`);
    }
    rawEvents.push(...events);
  }
  if (listingStateCount === 0) errors.push("Wix-warmupdata mangler en event-list-state");
  if (rawEvents.length === 0) errors.push("Wix-warmupdata indeholder ingen eventposter");
  if (rawEvents.length > AEROE_HOTEL_MAX_EVENTS) {
    errors.push(`Wix-warmupdata indeholder flere end ${AEROE_HOTEL_MAX_EVENTS} eventposter`);
    return {
      candidates: [],
      warnings,
      errors: [...new Set(errors)],
      rawEventCount: rawEvents.length,
      duplicateCount: 0,
    };
  }

  const candidates: NormalizedEventDraft[] = [];
  const byId = new Map<string, NormalizedEventDraft>();
  let duplicateCount = 0;
  rawEvents.forEach((event, index) => {
    const parsed = parseWixEvent(event, retrievedAt, index);
    errors.push(...parsed.errors);
    const candidate = parsed.candidate;
    if (!candidate) return;
    const previous = byId.get(candidate.sourceEventId);
    if (!previous) {
      byId.set(candidate.sourceEventId, candidate);
      candidates.push(candidate);
      return;
    }
    duplicateCount += 1;
    if (candidateSignature(previous) !== candidateSignature(candidate)) {
      errors.push(`Wix-event ${candidate.sourceEventId} gentages med modstridende kernefelter`);
    }
  });
  if (duplicateCount > 0) {
    warnings.push(`Wix-warmupdata gentog ${duplicateCount} event-UUID'er; dubletter blev fjernet`);
  }
  return {
    candidates,
    warnings,
    errors: [...new Set(errors)],
    rawEventCount: rawEvents.length,
    duplicateCount,
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  let pagesFetched = 0;
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: HOTEL_ORIGIN,
      maxBytes: AEROE_HOTEL_MAX_BODY_BYTES,
    });
    pagesFetched = 1;
    const parsed = parseAeroeHotelEventsPage(html, retrievedAt);
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

    const today = DateTime.fromJSDate(context.now).setZone(COPENHAGEN).startOf("day");
    const rangeEnd = today.plus({ months: 12 });
    const warnings = [...parsed.warnings];
    const candidates = parsed.candidates.filter((candidate) => {
      const eventDate = DateTime.fromISO(candidate.occurrences[0]!.date, { zone: COPENHAGEN });
      if (eventDate < today || eventDate > rangeEnd) {
        warnings.push(`Wix-event ${candidate.sourceEventId} ligger uden for indsamlingsvinduet`);
        return false;
      }
      return true;
    });
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates,
      errors: [],
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const aeroeHotelEventsSource: SourceAdapter = { definition, collect };
