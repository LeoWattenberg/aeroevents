import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import { DateTime } from "luxon";

import { errorMessage, fetchText } from "./http";
import { cleanText } from "./html";
import {
  normalizeFacebookPostText,
  parseFacebookAnnouncementText,
  parseFacebookTimestamp,
  type FacebookAnnouncementParseOptions,
} from "./facebook-post";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
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
      !(hostname === "facebook.com" || hostname.endsWith(".facebook.com")) ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return undefined;
    }
    url.hostname = "www.facebook.com";
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function externalId(url: URL): string {
  const event = url.pathname.match(/\/events\/(\d+)/)?.[1];
  if (event) {
    const occurrence = url.searchParams.get("event_time_id");
    return occurrence ? `${event}-${occurrence}` : event;
  }
  const groupPost = url.pathname.match(/\/groups\/[^/]+\/(?:posts|permalink)\/([^/]+)/i);
  if (groupPost?.[1]) return `post-${groupPost[1]}`;
  const pathPost = url.pathname.match(/\/posts\/([^/]+)/i)?.[1];
  if (pathPost) return `post-${pathPost}`;
  const queryPost = url.searchParams.get("story_fbid") ?? url.searchParams.get("fbid");
  if (queryPost) return `post-${queryPost}`;
  return `url-${smallHash(canonicalFacebookUrl(url).toString())}`;
}

export function facebookContentId(rawUrl: string): string {
  const url = facebookUrl(rawUrl);
  if (!url) throw new Error("Facebook-URL'en er ugyldig");
  return externalId(url);
}

export function canonicalFacebookContentUrl(rawUrl: string): string {
  const url = facebookUrl(rawUrl);
  if (!url) throw new Error("Facebook-URL'en er ugyldig");
  return canonicalFacebookUrl(url).toString();
}

function canonicalFacebookUrl(url: URL): URL {
  const result = new URL(url.toString());
  result.hash = "";
  const retained = new URLSearchParams();
  for (const key of ["story_fbid", "fbid", "id", "event_time_id"]) {
    const value = result.searchParams.get(key);
    if (value) retained.set(key, value);
  }
  result.search = retained.toString();
  return result;
}

function isConcreteFacebookContent(url: URL): boolean {
  return (
    /\/events\/\d+/i.test(url.pathname) ||
    /\/posts\/[^/]+/i.test(url.pathname) ||
    /\/groups\/[^/]+\/permalink\/[^/]+/i.test(url.pathname) ||
    (/\/(?:permalink|story)\.php$/i.test(url.pathname) &&
      Boolean(url.searchParams.get("story_fbid"))) ||
    Boolean(url.searchParams.get("fbid"))
  );
}

export function isConcreteFacebookContentUrl(rawUrl: string): boolean {
  const url = facebookUrl(rawUrl);
  return Boolean(url && isConcreteFacebookContent(url));
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

function structuredPosts(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(structuredPosts);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const graph = structuredPosts(object["@graph"]);
  const type = object["@type"];
  const postTypes = new Set(["SocialMediaPosting", "DiscussionForumPosting", "BlogPosting"]);
  const isPost =
    (typeof type === "string" && postTypes.has(type)) ||
    (Array.isArray(type) && type.some((item) => typeof item === "string" && postTypes.has(item)));
  return [...(isPost ? [object] : []), ...graph];
}

function multilineText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const $ = load(`<main>${value}</main>`);
  $("br").replaceWith("\n");
  $("p, div").each((_index, element) => {
    $(element).append("\n");
  });
  const result = normalizeFacebookPostText($("main").text());
  return result || undefined;
}

function publishedAtFromPage(
  $: ReturnType<typeof load>,
  messageElement?: AnyNode,
): string | undefined {
  const container = messageElement
    ? $(messageElement).closest("article, [role='article']").first()
    : undefined;
  const direct =
    $("meta[property='article:published_time']").attr("content") ??
    container?.find("time[datetime]").first().attr("datetime");
  if (direct) {
    const parsed = parseFacebookTimestamp(direct);
    if (parsed) return parsed.toUTC().toISO()!;
  }
  const epoch = container?.find("abbr[data-utime]").first().attr("data-utime");
  if (epoch && /^\d+$/.test(epoch)) {
    const parsed = DateTime.fromSeconds(Number(epoch), { zone: "utc" });
    if (parsed.isValid) return parsed.toISO()!;
  }
  return undefined;
}

function concreteSourceUrl($: ReturnType<typeof load>, requestedUrl: string): string {
  const candidate = $("meta[property='og:url']").attr("content");
  const parsed = candidate ? facebookUrl(candidate) : undefined;
  return canonicalFacebookUrl(parsed ?? new URL(requestedUrl)).toString();
}

function structuredEventSourceUrl(value: unknown, requestedUrl: string): string {
  const requested = new URL(requestedUrl);
  const supplied = typeof value === "string" ? facebookUrl(value) : undefined;
  const result = supplied ?? requested;
  const requestedEventId = requested.pathname.match(/\/events\/(\d+)/i)?.[1];
  const suppliedEventId = result.pathname.match(/\/events\/(\d+)/i)?.[1];
  const occurrenceId = requested.searchParams.get("event_time_id");
  if (occurrenceId && requestedEventId && suppliedEventId === requestedEventId) {
    result.searchParams.set("event_time_id", occurrenceId);
  }
  return canonicalFacebookUrl(result).toString();
}

function announcementTextFromPage($: ReturnType<typeof load>): {
  text?: string;
  titleHint?: string;
  publishedAt?: string;
  ambiguous: boolean;
  truncated: boolean;
} {
  const structured: Array<{ text: string; title?: string; publishedAt?: string }> = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    const raw = $(element).html();
    if (!raw) return;
    try {
      for (const post of structuredPosts(JSON.parse(raw))) {
        const text = multilineText(post.articleBody ?? post.text ?? post.description);
        if (!text) continue;
        const candidate = {
          text,
          ...(textValue(post.headline) ? { title: textValue(post.headline)! } : {}),
          ...(typeof post.datePublished === "string" ? { publishedAt: post.datePublished } : {}),
        };
        if (
          !structured.some(
            (item) =>
              item.text === candidate.text &&
              item.title === candidate.title &&
              item.publishedAt === candidate.publishedAt,
          )
        ) {
          structured.push(candidate);
        }
      }
    } catch {
      // The event parser reports malformed JSON-LD separately. Other scripts
      // on a Facebook page are irrelevant to announcement extraction.
    }
  });

  const messageSelectors = [
    "[data-testid='post_message']",
    "[data-ad-rendering-role='story_message']",
    "[data-ad-preview='message']",
    ".userContent[data-ft]",
  ];
  const messageElements = messageSelectors.flatMap((selector) => $(selector).toArray());
  let domTruncated = false;
  const messages = unique(
    messageElements
      .map((element) => {
        const clone = $(element).clone();
        domTruncated ||= clone
          .find(".see_more_link, [role='button']")
          .toArray()
          .some((item) =>
            /^(?:se mere|see more)$/iu.test(normalizeFacebookPostText($(item).text())),
          );
        clone.find(".see_more_link, [role='button']").remove();
        clone.find("br").replaceWith("\n");
        clone.find("p, div").each((_index, child) => {
          $(child).append("\n");
        });
        return normalizeFacebookPostText(clone.text());
      })
      .filter(Boolean),
  );
  const metaText = multilineText(
    $("meta[property='og:description']").attr("content") ??
      $("meta[name='description']").attr("content"),
  );
  const selected = structured[0]?.text ?? (messages.length === 1 ? messages[0] : undefined) ?? metaText;
  const rawTitle =
    structured[0]?.title ?? multilineText($("meta[property='og:title']").attr("content"));
  const titleHint = rawTitle?.replace(/\s*[|\-]\s*Facebook\s*$/iu, "").trim();
  const publishedAt =
    structured[0]?.publishedAt ?? publishedAtFromPage($, messageElements[0]);
  return {
    ...(selected ? { text: selected } : {}),
    ...(titleHint ? { titleHint } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ambiguous: structured.length > 1 || messages.length > 1,
    truncated:
      domTruncated ||
      Boolean(selected && /(?:…|\.\.\.)\s*(?:se mere|see more)?\s*$/iu.test(selected)),
  };
}

export interface FacebookPostTextInput {
  url: string;
  identityUrl?: string;
  text: string;
  retrievedAt: string;
  publishedAt?: string;
  titleHint?: string;
  titleOverride?: string;
}

export function parseFacebookPostText(
  input: FacebookPostTextInput,
): { candidates: NormalizedEventDraft[]; warnings: string[]; errors: string[]; evidence: string[] } {
  const url = facebookUrl(input.url);
  const identityUrl = facebookUrl(input.identityUrl ?? input.url);
  if (
    !url ||
    !identityUrl ||
    !isConcreteFacebookContent(url) ||
    !isConcreteFacebookContent(identityUrl)
  ) {
    return {
      candidates: [],
      warnings: [],
      errors: ["Opslagstekst kræver en konkret Facebook-event- eller post-permalink"],
      evidence: [],
    };
  }
  const now = new Date(input.retrievedAt);
  if (Number.isNaN(now.valueOf())) {
    return { candidates: [], warnings: [], errors: ["Indsamlingstidspunktet er ugyldigt"], evidence: [] };
  }
  if (input.publishedAt && !parseFacebookTimestamp(input.publishedAt)) {
    return { candidates: [], warnings: [], errors: ["Opslagets publiceringstidspunkt er ugyldigt"], evidence: [] };
  }
  const parseOptions: FacebookAnnouncementParseOptions = {
    now,
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.titleOverride
      ? { titleHint: input.titleOverride, preferTitleHint: true }
      : input.titleHint
        ? { titleHint: input.titleHint }
        : {}),
  };
  const parsed = parseFacebookAnnouncementText(input.text, parseOptions);
  if (parsed.errors.length > 0 || !parsed.title || parsed.occurrences.length === 0) {
    return {
      candidates: [],
      warnings: parsed.warnings,
      errors: parsed.errors.length ? parsed.errors : ["Opslagsteksten gav ingen eventkandidat"],
      evidence: parsed.evidence,
    };
  }
  const sourceUrl = canonicalFacebookUrl(url).toString();
  const id = externalId(identityUrl);
  const occurrencePrefix = `facebook-${smallHash(id)}`;
  const candidate: NormalizedEventDraft = {
    sourceId: definition.id,
    sourceEventId: id,
    stableId: `${definition.id}-${id}`,
    title: parsed.title,
    description: normalizeFacebookPostText(input.text),
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    ...(parsed.locationName ? { location: { name: parsed.locationName } } : {}),
    occurrences: parsed.occurrences.map((occurrence, index) => ({
      id: `${occurrencePrefix}-${index + 1}`,
      date: occurrence.date,
      ...(occurrence.startTime ? { startTime: occurrence.startTime } : {}),
      ...(occurrence.endTime ? { endTime: occurrence.endTime } : {}),
      allDay: occurrence.allDay,
      timeUnknown: occurrence.timeUnknown,
    })),
    status: parsed.status,
    ...(parsed.soldOut ? { availability: "sold-out" } : {}),
    attendance: parsed.attendance,
    ...(parsed.price ? { price: parsed.price } : {}),
    publication: "review",
    reviewReasons: [
      "Facebook-opslaget er maskinfortolket og skal kontrolleres mod originalen",
      ...parsed.reasons,
    ],
    provenance: {
      sourceId: definition.id,
      externalId: id,
      sourceUrl,
      retrievedAt: input.retrievedAt,
      ...(input.publishedAt ? { sourceModifiedAt: input.publishedAt } : {}),
    },
  };
  return { candidates: [candidate], warnings: parsed.warnings, errors: [], evidence: parsed.evidence };
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
  const requested = facebookUrl(requestedUrl);
  if (!requested || !isConcreteFacebookContent(requested)) {
    return {
      candidates: [],
      warnings: [],
      errors: ["Facebook-indsamling kræver en konkret event- eller post-permalink"],
    };
  }
  const $ = load(html);
  const pageText = cleanText($("body").text());
  const loginBlocked =
    $("#login_form, form[action*='login'], [data-testid='royal_login_form']").length > 0 ||
    /(?:log in|login|log på) (?:to|på) facebook/i.test(pageText) ||
    /you must log in|du skal logge ind/i.test(pageText);

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
    const sourceUrlValue = structuredEventSourceUrl(event.url, requestedUrl);
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
  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [
        JSON.stringify({
          sourceEventId: candidate.sourceEventId,
          title: candidate.title,
          occurrences: candidate.occurrences,
          location: candidate.location,
          status: candidate.status,
        }),
        candidate,
      ]),
    ).values(),
  ];
  if (uniqueCandidates.length > 1) {
    return {
      candidates: [],
      warnings: jsonErrors,
      errors: ["Facebook-siden indeholder flere forskellige events; brug den direkte event-permalink"],
    };
  }
  if (uniqueCandidates.length === 1) {
    return { candidates: uniqueCandidates, warnings: jsonErrors, errors: [] };
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
            sourceUrl: canonicalFacebookUrl(requested).toString(),
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

  if (isConcreteFacebookContent(requested)) {
    const announcement = announcementTextFromPage($);
    if (announcement.ambiguous) {
      return {
        candidates: [],
        warnings: jsonErrors,
        errors: ["Facebook-siden indeholder flere opslagstekster; vælg en konkret permalink"],
      };
    }
    if (announcement.truncated) {
      return {
        candidates: [],
        warnings: jsonErrors,
        errors: ["Facebook-opslagsteksten er afkortet; indsæt den fulde tekst manuelt"],
      };
    }
    if (announcement.text) {
      const parsed = parseFacebookPostText({
        url: concreteSourceUrl($, requestedUrl),
        identityUrl: requestedUrl,
        text: announcement.text,
        retrievedAt,
        ...(announcement.publishedAt ? { publishedAt: announcement.publishedAt } : {}),
        ...(announcement.titleHint ? { titleHint: announcement.titleHint } : {}),
      });
      if (parsed.candidates.length > 0) {
        return {
          candidates: parsed.candidates,
          warnings: [...jsonErrors, ...parsed.warnings],
          errors: [],
        };
      }
      return {
        candidates: [],
        warnings: [...jsonErrors, ...parsed.warnings],
        errors: parsed.errors,
      };
    }
  }

  return loginBlocked
    ? {
        candidates: [],
        warnings: jsonErrors,
        errors: ["Facebook kræver login; den offentlige URL kan ikke indsamles"],
      }
    : {
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
  if (!isConcreteFacebookContent(url)) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: ["Facebook-indsamling kræver en konkret event- eller post-permalink"],
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
      sourceUrl: canonicalFacebookUrl(url).toString(),
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
