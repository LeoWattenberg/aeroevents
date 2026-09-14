import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText, deduplicateBy } from "./html";
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

const definition = SOURCE_REGISTRY.marnav;
const NEMTILMELD_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const OPEN_HOUSE_TITLE = /^Åbent hus\b/iu;
const OPEN_HOUSE_MENTION = /Åbent hus\b/iu;
const MAX_DETAILS = 20;

/** The school's own front page links sold-out events that disappear from the tenant listing. */
export const MARNAV_DISCOVERY_URL = "https://www.marnav.dk/";
const MARNAV_DISCOVERY_ORIGIN = new URL(MARNAV_DISCOVERY_URL).origin;

export interface MarnavDiscoveryResult {
  urls: string[];
  warnings: string[];
  errors: string[];
}

export interface MarnavEventResult {
  candidate?: NormalizedEventDraft;
  excluded: boolean;
  warnings: string[];
  errors: string[];
}

interface JsonObject {
  [key: string]: unknown;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function schemaTypes(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === "string",
  );
}

function schemaEvents(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(schemaEvents);
  const item = object(value);
  if (!item) return [];
  const events = schemaTypes(item["@type"]).some((type) => type === "Event") ? [item] : [];
  return [...events, ...schemaEvents(item["@graph"])];
}

function publicEventId(sourceUrl: string): string | undefined {
  try {
    return new URL(sourceUrl).pathname.match(/^\/([1-9]\d*)\/?$/)?.[1];
  } catch {
    return undefined;
  }
}

export function parseMarnavDiscovery(
  html: string,
  pageUrl = MARNAV_DISCOVERY_URL,
): MarnavDiscoveryResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const urls: string[] = [];

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    let candidate: URL;
    try {
      candidate = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^\/([1-9]\d*)\/?$/.test(candidate.pathname)) return;
    const container = $(element).closest("article, bui-cta-icon-box").first();
    const context = cleanText(container.length > 0 ? container.text() : $(element).text());
    if (!OPEN_HOUSE_MENTION.test(context)) return;
    try {
      const safe = sameOriginHttpsUrl(candidate.toString(), NEMTILMELD_ORIGIN);
      const id = publicEventId(safe);
      if (id) urls.push(`${NEMTILMELD_ORIGIN}/${id}/`);
    } catch (error) {
      errors.push(`MarNavs eventliste har et usikkert NemTilmeld-link: ${errorMessage(error)}`);
    }
  });

  const unique = deduplicateBy(urls, (url) => url);
  if (unique.length !== urls.length) warnings.push("MarNavs eventliste gentog et Åbent hus-link");
  if (unique.length > MAX_DETAILS) errors.push(`MarNavs eventliste gav flere end ${MAX_DETAILS} Åbent hus-links`);
  if (unique.length === 0 && errors.length === 0) {
    errors.push("MarNavs eventliste indeholder ingen offentlige Åbent hus-links");
  }
  return { urls: unique, warnings, errors };
}

function parseSchemaInstant(value: unknown): DateTime | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.fromISO(value, { zone: COPENHAGEN, setZone: true });
  return parsed.isValid ? parsed.setZone(COPENHAGEN) : undefined;
}

function parseLocation(value: unknown): EventLocationDraft | undefined {
  const place = object(value);
  if (!place) return undefined;
  const addressValue = place.address;
  const postal = object(addressValue);
  const location: EventLocationDraft = {};
  const name = text(place.name);
  if (name) location.name = name;
  if (postal) {
    const address = text(postal.streetAddress);
    const postalCode = text(postal.postalCode);
    const city = text(postal.addressLocality);
    if (address) location.address = address;
    if (postalCode) location.postalCode = postalCode;
    if (city) location.city = city;
  } else {
    const address = text(addressValue);
    if (address) location.address = address;
  }
  return Object.keys(location).length > 0 ? location : undefined;
}

function eventStatus(value: unknown): EventStatus | undefined {
  const status = text(value);
  if (!status) return undefined;
  if (/EventScheduled$/i.test(status)) return "scheduled";
  if (/EventCancelled$/i.test(status)) return "cancelled";
  if (/EventPostponed$/i.test(status)) return "postponed";
  return undefined;
}

function occurrence(
  id: string,
  startValue: unknown,
  endValue: unknown,
): { value?: ExplicitOccurrenceDraft; error?: string } {
  const start = parseSchemaInstant(startValue);
  const end = endValue === undefined || endValue === null ? undefined : parseSchemaInstant(endValue);
  if (!start || (endValue !== undefined && endValue !== null && !end)) {
    return { error: "mangler et gyldigt start-/sluttidspunkt" };
  }
  if (end && end < start) return { error: "slutter før det starter" };
  const allDay = typeof startValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startValue);
  return {
    value: {
      id: `nemtilmeld-${id}`,
      date: start.toISODate()!,
      ...(!allDay ? { startTime: start.toFormat("HH:mm") } : {}),
      ...(end && end.toISODate() !== start.toISODate() ? { endDate: end.toISODate()! } : {}),
      ...(end && !allDay ? { endTime: end.toFormat("HH:mm") } : {}),
      allDay,
      timeUnknown: false,
    },
  };
}

export function parseMarnavEvent(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
): MarnavEventResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  let safeSourceUrl: string | undefined;
  try {
    safeSourceUrl = sameOriginHttpsUrl(sourceUrl, NEMTILMELD_ORIGIN);
  } catch (error) {
    errors.push(`NemTilmeld-linket er usikkert: ${errorMessage(error)}`);
  }
  const id = safeSourceUrl ? publicEventId(safeSourceUrl) : undefined;
  if (safeSourceUrl && !id) {
    errors.push("NemTilmeld-linket mangler et offentligt numerisk event-id");
  }

  const parsedScripts: unknown[] = [];
  $("script[type='application/ld+json']").each((index, element) => {
    const raw = $(element).html();
    if (!raw?.trim()) return;
    try {
      parsedScripts.push(JSON.parse(raw));
    } catch {
      errors.push(`NemTilmeld-sidens JSON-LD-blok ${index + 1} er ugyldig`);
    }
  });
  const events = parsedScripts.flatMap(schemaEvents);
  if (events.length !== 1) {
    errors.push(`NemTilmeld-siden indeholder ${events.length} Event-objekter; forventede ét`);
  }
  const event = events[0];
  if (!event || !id) return { excluded: false, warnings, errors };

  const title = text(event.name);
  if (!title) errors.push(`NemTilmeld-event ${id} mangler titel`);
  if (title && !OPEN_HOUSE_TITLE.test(title)) {
    return {
      excluded: true,
      warnings: [`NemTilmeld-event ${id} er ikke på allowlisten “Åbent hus”`],
      errors,
    };
  }

  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = sameOriginHttpsUrl(String(event.url ?? ""), NEMTILMELD_ORIGIN);
  } catch (error) {
    errors.push(`NemTilmeld-event ${id} har et usikkert kanonisk link: ${errorMessage(error)}`);
  }
  if (canonicalUrl && publicEventId(canonicalUrl) !== id) {
    errors.push(`NemTilmeld-event ${id} har et andet id i JSON-LD-linket`);
  }
  const visibleId = $("meta.js-setting[data-name='org_event_id']").attr("data-value");
  if (visibleId && visibleId !== id) errors.push(`NemTilmeld-event ${id} har et andet synligt event-id`);

  const organizer = object(event.organizer);
  if (!/Marstal Navigationsskole/iu.test(text(organizer?.name) ?? "")) {
    errors.push(`NemTilmeld-event ${id} tilhører ikke Marstal Navigationsskole`);
  }
  const parsedOccurrence = occurrence(id, event.startDate, event.endDate);
  if (parsedOccurrence.error) errors.push(`NemTilmeld-event ${id} ${parsedOccurrence.error}`);
  const location = parseLocation(event.location);
  if (!location?.name) errors.push(`NemTilmeld-event ${id} mangler spillested`);
  const status = eventStatus(event.eventStatus);
  if (!status) errors.push(`NemTilmeld-event ${id} mangler en kendt eventstatus`);
  if (
    errors.length > 0 ||
    !title ||
    !canonicalUrl ||
    !parsedOccurrence.value ||
    !location?.name ||
    !status
  ) {
    return { excluded: false, warnings, errors };
  }

  const soldOutText = cleanText($("#price_selection_alternative_text").text());
  const waitingListText = cleanText($("#price_selection_waiting_list_text").text());
  const soldOut = /ikke flere pladser|udsolgt|fuldt booket/iu.test(soldOutText);
  const waitingList = /venteliste/iu.test(waitingListText);
  const description = text(event.description);
  const bookingDetails = soldOut && waitingList
    ? "Udsolgt; venteliste er åben."
    : soldOut
      ? "Udsolgt."
      : "Tilmelding kræves.";

  return {
    excluded: false,
    warnings,
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId: id,
      stableId: `${definition.id}-${id}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location,
      occurrences: [parsedOccurrence.value],
      status,
      availability: soldOut ? "sold-out" : "available",
      attendance: "registration",
      attendanceDetails: "Arrangementet er offentligt, men tilmelding kræves.",
      bookingUrl: canonicalUrl,
      bookingRequired: true,
      bookingDetails,
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: id,
        sourceUrl: canonicalUrl,
        retrievedAt,
      },
    },
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  let pagesFetched = 0;
  try {
    const listingHtml = await fetchText(context, MARNAV_DISCOVERY_URL, {
      expectedOrigin: MARNAV_DISCOVERY_ORIGIN,
    });
    pagesFetched += 1;
    const discovery = parseMarnavDiscovery(listingHtml);
    warnings.push(...discovery.warnings);
    errors.push(...discovery.errors);
    if (errors.length === 0) {
      for (const url of discovery.urls) {
        try {
          const detailHtml = await fetchText(context, url, { expectedOrigin: NEMTILMELD_ORIGIN });
          pagesFetched += 1;
          const parsed = parseMarnavEvent(detailHtml, url, retrievedAt);
          warnings.push(...parsed.warnings);
          errors.push(...parsed.errors);
          if (parsed.candidate) candidates.push(parsed.candidate);
        } catch (error) {
          errors.push(`${url}: ${errorMessage(error)}`);
          break;
        }
      }
    }

    const today = DateTime.fromJSDate(context.now).setZone(COPENHAGEN).startOf("day");
    const rangeEnd = today.plus({ months: 12 });
    const current = candidates.filter((candidate) => {
      const date = DateTime.fromISO(candidate.occurrences[0]!.date, { zone: COPENHAGEN });
      if (date < today || date > rangeEnd) {
        warnings.push(`NemTilmeld-event ${candidate.sourceEventId} ligger uden for indsamlingsvinduet`);
        return false;
      }
      return true;
    });
    if (current.length === 0 && errors.length === 0) {
      errors.push("MarNav returnerede ingen fremtidige allowlistede Åbent hus-events");
    }
    if (new Set(current.map((candidate) => candidate.sourceEventId)).size !== current.length) {
      errors.push("MarNav returnerede samme offentlige event-id flere gange");
    }
    if (errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        discardedCandidateCount: current.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: current,
      errors: [],
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    if (pagesFetched === 0) {
      return {
        status: "failed",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: [errorMessage(error)],
        warnings,
      };
    }
    return {
      status: "partial",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings,
      discardedCandidateCount: 0,
    };
  }
}

export const marnavSource: SourceAdapter = { definition, collect };
