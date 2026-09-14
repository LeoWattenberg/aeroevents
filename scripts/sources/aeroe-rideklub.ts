import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText, deduplicateBy } from "./html";
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

const definition = SOURCE_REGISTRY["aeroe-rideklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const MAX_EVENTS = 100;
const MAX_SOURCE_EVENT_ID_LENGTH = 100;
const EVENT_PATH = /^\/events-1\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const ACCESS_REVIEW_REASON =
  "Rideklubbens kalender skelner ikke konsekvent mellem offentlige arrangementer og medlemsaktiviteter.";

export interface AeroeRideklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  rawEventCount: number;
}

function isoDate(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { zone: COPENHAGEN });
  return parsed.isValid && parsed.toISODate() === value ? value : undefined;
}

function localTime(value: string): string | undefined {
  const match = cleanText(value).match(/^([01]?\d|2[0-3])[.:]([0-5]\d)$/);
  return match?.[1] && match[2]
    ? `${match[1].padStart(2, "0")}:${match[2]}`
    : undefined;
}

function eventStatus(value: string): EventStatus {
  if (/\baflyst\b/iu.test(value)) return "cancelled";
  if (/\b(?:udsat|udskudt|flyttet)\b/iu.test(value)) return "postponed";
  return "scheduled";
}

function locationFromArticle(
  article: ReturnType<ReturnType<typeof load>>,
): EventLocationDraft | undefined {
  const block = article.find(".eventlist-meta-address").first();
  if (block.length === 0) return undefined;
  const lines = block
    .find(".eventlist-meta-address-line")
    .toArray()
    .map((element) => cleanText(article.find(element).text()))
    .filter((line) => line && !/^denmark$/iu.test(line));
  if (lines.length > 0) {
    const locality = lines.at(-1)?.match(/^(.+?),\s*(\d{4})$/);
    return {
      name: "Ærø Rideklub",
      ...(lines[0] ? { address: lines[0] } : {}),
      ...(locality?.[2] ? { postalCode: locality[2] } : {}),
      ...(locality?.[1] ? { city: cleanText(locality[1]) } : {}),
    };
  }
  const clone = block.clone();
  clone.find("a").remove();
  const name = cleanText(clone.text());
  return name ? { name } : undefined;
}

function descriptionFromArticle(
  article: ReturnType<ReturnType<typeof load>>,
): string | undefined {
  const block = article.find(".eventlist-excerpt, .eventlist-description").first().clone();
  block.find("script, style, noscript, svg").remove();
  const description = cleanText(block.text());
  return description || undefined;
}

function occurrenceFromArticle(
  article: ReturnType<ReturnType<typeof load>>,
  sourceEventId: string,
  errors: string[],
): ExplicitOccurrenceDraft | undefined {
  const dateElements = article.find(".eventlist-meta-date time.event-date").toArray();
  const startDate = isoDate(article.find(".eventlist-meta-date time.event-date").first().attr("datetime"));
  const endDate = isoDate(
    dateElements.length > 1
      ? article.find(".eventlist-meta-date time.event-date").last().attr("datetime")
      : undefined,
  );
  if (!startDate) {
    errors.push(`Rideklub-event ${sourceEventId} mangler en gyldig startdato`);
    return undefined;
  }
  if (dateElements.length > 2 || (dateElements.length > 1 && !endDate)) {
    errors.push(`Rideklub-event ${sourceEventId} har et ukendt datointerval`);
    return undefined;
  }
  if (endDate && endDate < startDate) {
    errors.push(`Rideklub-event ${sourceEventId} slutter før startdatoen`);
    return undefined;
  }

  const timeElements = article.find(".eventlist-meta-time time").toArray();
  if (timeElements.length === 0) {
    return {
      id: `rideklub-${sourceEventId}`,
      date: startDate,
      ...(endDate && endDate !== startDate ? { endDate } : {}),
      allDay: true,
      timeUnknown: false,
    };
  }
  if (timeElements.length > 2) {
    errors.push(`Rideklub-event ${sourceEventId} har et ukendt tidsformat`);
    return undefined;
  }
  if (endDate && endDate !== startDate && timeElements.length !== 2) {
    errors.push(`Rideklub-event ${sourceEventId} mangler start- eller sluttid for datointervallet`);
    return undefined;
  }

  const first = article.find(".eventlist-meta-time time").first();
  const last = article.find(".eventlist-meta-time time").last();
  const startTime = localTime(first.text());
  const finishTime = timeElements.length === 2 ? localTime(last.text()) : undefined;
  const timeStartDate = isoDate(first.attr("datetime"));
  const timeEndDate = timeElements.length === 2 ? isoDate(last.attr("datetime")) : undefined;
  if (!startTime || !timeStartDate || timeStartDate !== startDate) {
    errors.push(`Rideklub-event ${sourceEventId} har en ugyldig eller modstridende starttid`);
    return undefined;
  }
  const effectiveEndDate = endDate ?? startDate;
  if (
    timeElements.length === 2 &&
    (!finishTime || !timeEndDate || timeEndDate !== effectiveEndDate)
  ) {
    errors.push(`Rideklub-event ${sourceEventId} har en ugyldig eller modstridende sluttid`);
    return undefined;
  }
  if (finishTime && effectiveEndDate === startDate && finishTime <= startTime) {
    errors.push(`Rideklub-event ${sourceEventId} slutter ikke efter starttidspunktet`);
    return undefined;
  }
  return {
    id: `rideklub-${sourceEventId}`,
    date: startDate,
    startTime,
    ...(endDate && endDate !== startDate ? { endDate } : {}),
    ...(finishTime ? { endTime: finishTime } : {}),
    allDay: false,
    timeUnknown: false,
  };
}

export function parseAeroeRideklubPage(
  html: string,
  retrievedAt: string,
): AeroeRideklubParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];

  const canonical = $("link[rel='canonical']").attr("href");
  try {
    if (!canonical || sameOriginHttpsUrl(canonical, SOURCE_ORIGIN) !== definition.url) {
      errors.push("Ærø Rideklubs canonical-link matcher ikke aktivitetskalenderen");
    }
  } catch {
    errors.push("Ærø Rideklubs canonical-link er usikkert");
  }
  if (!cleanText($("title").text()).endsWith("— Ærø Rideklub")) {
    errors.push("Aktivitetskalenderen kan ikke identificeres som Ærø Rideklubs side");
  }
  const container = $(".eventlist.eventlist--upcoming");
  if (container.length !== 1) {
    errors.push("Ærø Rideklubs blok med kommende arrangementer mangler");
  }
  const articles = container.find("article.eventlist-event--upcoming").toArray();
  if (articles.length > MAX_EVENTS) {
    errors.push(`Ærø Rideklub viser flere end ${MAX_EVENTS} kommende arrangementer`);
  }
  if (errors.length > 0) {
    return { candidates: [], warnings, errors, rawEventCount: articles.length };
  }

  articles.forEach((element, index) => {
    const article = $(element);
    const titleLink = article.find("a.eventlist-title-link[href]");
    const title = cleanText(titleLink.first().text());
    const href = titleLink.first().attr("href");
    let sourceUrl: string | undefined;
    let sourceEventId: string | undefined;
    if (titleLink.length !== 1 || !href) {
      errors.push(`Rideklub-event ${index + 1} mangler ét entydigt titellink`);
    } else {
      try {
        sourceUrl = sameOriginHttpsUrl(href, SOURCE_ORIGIN);
        const parsed = new URL(sourceUrl);
        const match = parsed.pathname.match(EVENT_PATH);
        if (
          !match?.[1] ||
          match[1].length > MAX_SOURCE_EVENT_ID_LENGTH ||
          parsed.search ||
          parsed.hash
        ) {
          errors.push(`Rideklub-event ${index + 1} har et ugyldigt eventlink`);
        } else {
          sourceEventId = match[1];
        }
      } catch (error) {
        errors.push(`Rideklub-event ${index + 1} har et usikkert link: ${errorMessage(error)}`);
      }
    }
    if (!title || title.length > 240) {
      errors.push(`Rideklub-event ${sourceEventId ?? index + 1} mangler en gyldig titel`);
    }
    if (!sourceEventId || !sourceUrl || !title) return;

    const eventErrors: string[] = [];
    const occurrence = occurrenceFromArticle(article, sourceEventId, eventErrors);
    errors.push(...eventErrors);
    if (!occurrence) return;

    const description = descriptionFromArticle(article);
    if (description && description.length > 10_000) {
      errors.push(`Rideklub-event ${sourceEventId} har en for lang beskrivelse`);
      return;
    }
    const statusText = cleanText(article.find(".eventlist-datetag-status").text());
    const status = eventStatus(`${title} ${statusText}`);
    const combinedText = `${title}\n${description ?? ""}`;
    const registration = /\b(?:tilmeld|bestil|reservation)\w*\b/iu.test(combinedText);
    const clearlyMembersOnly = /\b(?:kun\s+for\s+medlemmer|medlemsaktivitet)\b/iu.test(combinedText);
    const location = locationFromArticle(article);
    if (
      (location?.name && location.name.length > 200) ||
      (location?.address && location.address.length > 300) ||
      (location?.city && location.city.length > 100)
    ) {
      errors.push(`Rideklub-event ${sourceEventId} har et for langt stedfelt`);
      return;
    }
    const reviewReasons = [ACCESS_REVIEW_REASON];
    if (occurrence.startTime === "00:00") {
      reviewReasons.push("Kilden angiver start ved midnat; tidspunktet bør kontrolleres.");
    }
    if (!location) reviewReasons.push("Kilden angiver ikke et sted for arrangementet.");
    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(location ? { location } : {}),
      occurrences: [occurrence],
      status,
      attendance: clearlyMembersOnly ? "members" : registration ? "registration" : "unknown",
      ...(registration ? { bookingRequired: true } : {}),
      publication: "review",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl,
        retrievedAt,
      },
    });
  });

  const unique = deduplicateBy(candidates, (candidate) => candidate.sourceEventId);
  if (unique.length !== candidates.length) {
    errors.push("Ærø Rideklubs kalender indeholder samme eventlink flere gange");
  }
  return { candidates: unique, warnings, errors, rawEventCount: articles.length };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    // Use the public rendered page. Squarespace's format=json/ical variants are
    // deliberately not requested because this site's robots.txt excludes them.
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseAeroeRideklubPage(html, retrievedAt);
    const today = DateTime.fromJSDate(context.now).setZone(COPENHAGEN).startOf("day");
    const rangeEnd = today.plus({ months: 12 });
    const current = parsed.candidates.filter((candidate) => {
      const start = DateTime.fromISO(candidate.occurrences[0]!.date, { zone: COPENHAGEN });
      return start >= today && start <= rangeEnd;
    });
    const currentIds = new Set(current.map((candidate) => candidate.sourceEventId));
    const excludedSourceEventIds = parsed.candidates
      .map((candidate) => candidate.sourceEventId)
      .filter((sourceEventId) => !currentIds.has(sourceEventId));
    const errors = [...parsed.errors];
    if (parsed.rawEventCount === 0) errors.push("Ærø Rideklub viser ingen kommende arrangementer");
    if (current.length === 0 && parsed.rawEventCount > 0) {
      errors.push("Ærø Rideklub viser ingen arrangementer i indsamlingsvinduet");
    }
    if (errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: [...new Set(errors)],
        warnings: parsed.warnings,
        discardedCandidateCount: current.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: current,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds,
      errors: [],
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const aeroeRideklubSource: SourceAdapter = { definition, collect };
