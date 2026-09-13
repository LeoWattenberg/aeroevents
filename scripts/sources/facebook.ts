import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY.facebook;
const COPENHAGEN = "Europe/Copenhagen";

export interface FacebookManualDiscovery {
  url: string;
  title: string;
  date: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  description?: string;
  organizerId?: string;
  location?: EventLocationDraft;
}

function facebookUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    if (
      url.protocol !== "https:" ||
      !(hostname === "facebook.com" || hostname.endsWith(".facebook.com"))
    ) {
      return undefined;
    }
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function smallHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function externalId(url: URL): string {
  return url.pathname.match(/\/events\/(\d+)/)?.[1] ?? `url-${smallHash(url.toString())}`;
}

function parseDateTime(value: unknown): { date: string; time?: string } | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const hasExplicitOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parsed = hasExplicitOffset
    ? DateTime.fromISO(value, { setZone: true }).setZone(COPENHAGEN)
    : DateTime.fromISO(value, { zone: COPENHAGEN });
  if (!parsed.isValid) return undefined;
  return { date: parsed.toISODate()!, time: parsed.toFormat("HH:mm") };
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const $ = load(`<main>${value}</main>`);
  $("br").replaceWith("\n");
  const result = $("main").text().replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  return result || undefined;
}

function structuredEvents(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(structuredEvents);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const graph = structuredEvents(object["@graph"]);
  const type = object["@type"];
  const isEvent = type === "Event" || (Array.isArray(type) && type.includes("Event"));
  return [...(isEvent ? [object] : []), ...graph];
}

function schemaLocation(value: unknown): EventLocationDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const address = object.address;
  const result: EventLocationDraft = {};
  if (typeof object.name === "string" && cleanText(object.name))
    result.name = cleanText(object.name);
  if (typeof address === "string" && cleanText(address)) {
    result.address = cleanText(address);
  } else if (address && typeof address === "object") {
    const addressObject = address as Record<string, unknown>;
    if (typeof addressObject.streetAddress === "string")
      result.address = cleanText(addressObject.streetAddress);
    if (typeof addressObject.postalCode === "string")
      result.postalCode = cleanText(addressObject.postalCode);
    if (typeof addressObject.addressLocality === "string")
      result.city = cleanText(addressObject.addressLocality);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function draftFromFields(
  fields: {
    sourceUrl: string;
    title: string;
    start: { date: string; time?: string };
    end?: { date: string; time?: string };
    description?: string;
    location?: EventLocationDraft;
    cancelled?: boolean;
    organizerId?: string;
  },
  retrievedAt: string,
): NormalizedEventDraft {
  const url = new URL(fields.sourceUrl);
  const id = externalId(url);
  const occurrence: ExplicitOccurrenceDraft = {
    id: `facebook-${id}`,
    date: fields.start.date,
    ...(fields.start.time ? { startTime: fields.start.time } : {}),
    ...(fields.end ? { endDate: fields.end.date } : {}),
    ...(fields.end?.time ? { endTime: fields.end.time } : {}),
    allDay: fields.start.time === undefined,
    timeUnknown: false,
  };
  return {
    sourceId: definition.id,
    sourceEventId: id,
    stableId: `${definition.id}-${id}`,
    title: fields.title,
    ...(fields.description ? { description: fields.description } : {}),
    organizerId: fields.organizerId ?? definition.organizerId,
    categoryIds: [...definition.categoryIds],
    ...(fields.location ? { location: fields.location } : {}),
    occurrences: [occurrence],
    status: fields.cancelled ? "cancelled" : "scheduled",
    attendance: "unknown",
    publication: "review",
    reviewReasons: [
      "Facebook-oplysninger er kun et fund og skal kontrolleres mod arrangørens opslag",
    ],
    provenance: {
      sourceId: definition.id,
      externalId: id,
      sourceUrl: fields.sourceUrl,
      retrievedAt,
    },
  };
}

export function parseFacebookPublicPage(
  html: string,
  requestedUrl: string,
  retrievedAt: string,
): { candidates: NormalizedEventDraft[]; warnings: string[]; errors: string[] } {
  const $ = load(html);
  const pageText = cleanText($("body").text());
  if (
    $("#login_form, form[action*='login'], [data-testid='royal_login_form']").length > 0 ||
    /(?:log in|login|log på) (?:to|på) facebook/i.test(pageText) ||
    /you must log in|du skal logge ind/i.test(pageText)
  ) {
    return {
      candidates: [],
      warnings: [],
      errors: ["Facebook kræver login; den offentlige URL kan ikke indsamles"],
    };
  }

  const events: Record<string, unknown>[] = [];
  const jsonErrors: string[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    const raw = $(element).html();
    if (!raw) return;
    try {
      events.push(...structuredEvents(JSON.parse(raw)));
    } catch {
      jsonErrors.push("Et JSON-LD-felt på Facebook-siden kunne ikke aflæses");
    }
  });

  const candidates: NormalizedEventDraft[] = [];
  for (const event of events) {
    const title = textValue(event.name);
    const start = parseDateTime(event.startDate);
    if (!title || !start) continue;
    const sourceUrlValue =
      typeof event.url === "string" && facebookUrl(event.url)
        ? facebookUrl(event.url)!.toString()
        : requestedUrl;
    candidates.push(
      draftFromFields(
        {
          sourceUrl: sourceUrlValue,
          title,
          start,
          ...(parseDateTime(event.endDate) ? { end: parseDateTime(event.endDate)! } : {}),
          ...(textValue(event.description)
            ? { description: textValue(event.description)! }
            : {}),
          ...(schemaLocation(event.location) ? { location: schemaLocation(event.location)! } : {}),
          cancelled: event.eventStatus === "https://schema.org/EventCancelled",
        },
        retrievedAt,
      ),
    );
  }
  if (candidates.length > 0) {
    return { candidates, warnings: jsonErrors, errors: [] };
  }

  const title = cleanText($("meta[property='og:title']").attr("content") ?? "");
  const start = parseDateTime(
    $("meta[property='event:start_time'], meta[property='og:event:start_time']")
      .first()
      .attr("content"),
  );
  if (title && start) {
    const description = textValue($("meta[property='og:description']").attr("content"));
    const end = parseDateTime(
      $("meta[property='event:end_time'], meta[property='og:event:end_time']")
        .first()
        .attr("content"),
    );
    return {
      candidates: [
        draftFromFields(
          {
            sourceUrl: requestedUrl,
            title,
            start,
            ...(end ? { end } : {}),
            ...(description ? { description } : {}),
          },
          retrievedAt,
        ),
      ],
      warnings: [
        ...jsonErrors,
        "Facebook-fundet kom fra Open Graph-felter og kræver ekstra kontrol",
      ],
      errors: [],
    };
  }

  return {
    candidates: [],
    warnings: jsonErrors,
    errors: [
      "Facebook-siden var tilgængelig, men indeholdt ikke offentlige, strukturerede eventoplysninger",
    ],
  };
}

export async function collectFacebookPublicUrl(
  rawUrl: string,
  context: CollectionContext,
): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const url = facebookUrl(rawUrl);
  if (!url) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: ["Facebook-kilden skal være en offentlig https-URL på facebook.com"],
    };
  }
  try {
    const html = await fetchText(context, url.toString(), { expectedOrigin: url.origin });
    const parsed = parseFacebookPublicPage(html, url.toString(), retrievedAt);
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        warnings: parsed.warnings,
        errors: parsed.errors,
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      warnings: parsed.warnings,
      errors: [],
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: [errorMessage(error)],
    };
  }
}

export function createFacebookManualDiscovery(
  input: FacebookManualDiscovery,
  now: Date,
): NormalizedEventDraft {
  const url = facebookUrl(input.url);
  if (!url) throw new Error("Facebook-URL'en er ugyldig");
  const start = parseDateTime(
    input.startTime ? `${input.date}T${input.startTime}:00` : input.date,
  );
  const end = input.endDate || input.endTime
    ? parseDateTime(
        input.endTime
          ? `${input.endDate ?? input.date}T${input.endTime}:00`
          : input.endDate,
      )
    : undefined;
  if (!start) throw new Error("Facebook-fundets startdato eller -tid er ugyldig");
  if ((input.endDate || input.endTime) && !end)
    throw new Error("Facebook-fundets sluttid er ugyldig");
  if (!cleanText(input.title)) throw new Error("Facebook-fundet mangler titel");
  return draftFromFields(
    {
      sourceUrl: url.toString(),
      title: cleanText(input.title),
      start,
      ...(end ? { end } : {}),
      ...(input.description ? { description: cleanText(input.description) } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.organizerId ? { organizerId: input.organizerId } : {}),
    },
    now.toISOString(),
  );
}

async function collectWithoutConfiguredUrl(
  context: CollectionContext,
): Promise<CollectionResult> {
  return {
    status: "failed",
    source: definition,
    retrievedAt: context.now.toISOString(),
    pagesFetched: 0,
    candidates: [],
    warnings: [],
    errors: [
      "Facebook-indsamling kræver en konkret offentlig URL; brug collectFacebookPublicUrl",
    ],
  };
}

export const facebookSource: SourceAdapter = {
  definition,
  collect: collectWithoutConfiguredUrl,
};
