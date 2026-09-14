import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import { boundedWeeklySchedule } from "./series-schedule";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-folkedans"];
const FOLKEDANS_ORIGIN = new URL(definition.url).origin;
const ADULT_SERIES_TITLE = "Folkedans for alle (unge og voksne)";
const ADULT_SERIES_PATH = "/begivenheder/folkedans-for-alle-unge-og-voksne";
const ADULT_SERIES_SOURCE_EVENT_ID = "adult-series-2026-27";
const ADULT_SERIES_MAX_SUFFIX = 19;

export interface FolkedansParseResult {
  candidates: NormalizedEventDraft[];
  excludedSourceEventIds: string[];
  warnings: string[];
  errors: string[];
}

interface ParsedInstant {
  date: string;
  time: string;
}

function parseUsInstant(value: string): ParsedInstant | undefined {
  const match = cleanText(value).match(
    /^(\d{1,2})\/(\d{1,2})\/(20\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
    return undefined;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!validCalendarDate(year, month, day) || hour < 1 || hour > 12 || minute > 59) {
    return undefined;
  }
  if (match[6].toUpperCase() === "AM") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return {
    date: isoDate(year, month, day),
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function parseInterval(value: string, id: string): ExplicitOccurrenceDraft | undefined {
  const parts = cleanText(value).split(/\s+[-–—]\s+/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const start = parseUsInstant(parts[0]);
  const end = parseUsInstant(parts[1]);
  if (!start || !end) return undefined;
  return {
    id: `folkedans-${id}`,
    date: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    allDay: false,
    timeUnknown: false,
  };
}

function textWithoutIcon(
  element: ReturnType<ReturnType<typeof load>>,
): string {
  const clone = element.clone();
  clone.find("i, svg").remove();
  return cleanText(clone.text());
}

function parseLocation(value: string): EventLocationDraft | undefined {
  const parts = value.split(",").map(cleanText).filter(Boolean);
  const name = parts[0];
  if (!name) return undefined;
  const location: EventLocationDraft = { name };
  if (parts[1]) location.city = parts[1];
  if (Object.keys(location).length === 0) return undefined;
  return location;
}

function secureUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const resolved = new URL(value, baseUrl);
  return resolved.protocol === "https:" ? resolved.toString() : undefined;
}

function chronology(occurrence: ExplicitOccurrenceDraft): number {
  return `${occurrence.date}T${occurrence.startTime ?? "00:00"}`.localeCompare(
    `${occurrence.endDate ?? occurrence.date}T${occurrence.endTime ?? occurrence.startTime ?? "00:00"}`,
  );
}

function adultSeriesOrdinal(candidate: NormalizedEventDraft): number | undefined {
  if (candidate.title !== ADULT_SERIES_TITLE) return undefined;
  let url: URL;
  try {
    url = new URL(candidate.provenance.sourceUrl);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (path === ADULT_SERIES_PATH) return 0;
  const prefix = `${ADULT_SERIES_PATH}-`;
  const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  const ordinal = /^\d+$/u.test(suffix) ? Number(suffix) : undefined;
  return ordinal !== undefined &&
    suffix === String(ordinal) &&
    Number.isSafeInteger(ordinal) &&
    ordinal >= 1 &&
    ordinal <= ADULT_SERIES_MAX_SUFFIX
    ? ordinal
    : undefined;
}

function seriesMetadata(candidate: NormalizedEventDraft): string {
  const {
    sourceEventId: _sourceEventId,
    stableId: _stableId,
    occurrences: _occurrences,
    provenance,
    ...metadata
  } = candidate;
  const {
    externalId: _externalId,
    sourceUrl: _sourceUrl,
    ...stableProvenance
  } = provenance;
  return JSON.stringify({ metadata, provenance: stableProvenance });
}

function collapseAdultSeries(
  candidates: NormalizedEventDraft[],
  warnings: string[],
): { candidates: NormalizedEventDraft[]; excludedSourceEventIds: string[] } {
  const members = candidates
    .map((candidate, index) => ({ candidate, index, ordinal: adultSeriesOrdinal(candidate) }))
    .filter((item): item is { candidate: NormalizedEventDraft; index: number; ordinal: number } =>
      item.ordinal !== undefined
    );
  if (members.length < 2) {
    return { candidates, excludedSourceEventIds: [ADULT_SERIES_SOURCE_EVENT_ID] };
  }

  const ordinals = new Set<number>();
  for (const { ordinal } of members) {
    if (ordinals.has(ordinal)) {
      warnings.push("Folkedanserforeningens voksenserie har gentagne ordinaler i eventlinkene og blev ikke samlet");
      return { candidates, excludedSourceEventIds: [ADULT_SERIES_SOURCE_EVENT_ID] };
    }
    ordinals.add(ordinal);
  }
  const signature = seriesMetadata(members[0]!.candidate);
  if (members.some(({ candidate }) => seriesMetadata(candidate) !== signature)) {
    warnings.push("Folkedanserforeningens voksenserie har modstridende metadata og blev ikke samlet");
    return { candidates, excludedSourceEventIds: [ADULT_SERIES_SOURCE_EVENT_ID] };
  }

  const occurrences = members
    .flatMap(({ candidate }) => candidate.occurrences)
    .sort((left, right) =>
      `${left.date}T${left.startTime ?? ""}`.localeCompare(`${right.date}T${right.startTime ?? ""}`),
    );
  const schedule = boundedWeeklySchedule(occurrences);
  if (!schedule) {
    warnings.push("Folkedanserforeningens voksenserie kunne ikke bevares som én tabsfri ugentlig regel");
    return { candidates, excludedSourceEventIds: [ADULT_SERIES_SOURCE_EVENT_ID] };
  }

  const template = members.find(({ ordinal }) => ordinal === 0)?.candidate ?? members[0]!.candidate;
  const series: NormalizedEventDraft = {
    ...template,
    sourceEventId: ADULT_SERIES_SOURCE_EVENT_ID,
    stableId: `${definition.id}-${ADULT_SERIES_SOURCE_EVENT_ID}`,
    schedule,
    occurrences,
    provenance: {
      ...template.provenance,
      externalId: ADULT_SERIES_SOURCE_EVENT_ID,
      sourceUrl: new URL(ADULT_SERIES_PATH, `${FOLKEDANS_ORIGIN}/`).toString(),
    },
  };
  const memberIndexes = new Set(members.map(({ index }) => index));
  const firstIndex = Math.min(...memberIndexes);
  return {
    candidates: candidates.flatMap((candidate, index) => {
      if (index === firstIndex) return [series];
      return memberIndexes.has(index) ? [] : [candidate];
    }),
    excludedSourceEventIds: members.map(({ candidate }) => candidate.sourceEventId),
  };
}

export function parseFolkedansPage(
  html: string,
  retrievedAt: string,
  pageUrl = definition.url,
): FolkedansParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidatesById = new Map<string, NormalizedEventDraft>();
  const upcomingContainers = $(".events-container [data-event-filter='kommende-begivenheder']");
  if (upcomingContainers.length === 0) {
    errors.push("Folkedanserforeningens side mangler sektionen med kommende begivenheder");
    return { candidates: [], excludedSourceEventIds: [], warnings, errors };
  }
  if (upcomingContainers.length > 1) {
    warnings.push("Site123 gengav sektionen med kommende begivenheder flere gange; dubletter blev fjernet");
  }

  upcomingContainers.each((_containerIndex, container) => {
    const eventList = $(container).children(".events");
    if (eventList.length !== 1) {
      errors.push("En af Folkedanserforeningens kommende-sektioner mangler eventlisten");
      return;
    }
    eventList.children(".event[data-unique-id]").each((index, element) => {
      const card = $(element);
      const sourceEventId = cleanText(card.attr("data-unique-id") ?? "");
      const titleAnchor = card.find(".event-title a[href]").first();
      const title = cleanText(titleAnchor.text());
      const href = titleAnchor.attr("href");
      const clockItem = card.find(".event-meta li:has(i[data-icon-name='clock-o'])").first();
      const occurrence = parseInterval(textWithoutIcon(clockItem), sourceEventId);
      if (!/^[a-z0-9-]{6,}$/i.test(sourceEventId)) {
        errors.push(`Folkedanserforeningens event ${index + 1} mangler et stabilt data-unique-id`);
        return;
      }
      if (!title || !href) {
        errors.push(`Folkedanserforeningens event ${sourceEventId} mangler titel eller link`);
        return;
      }
      if (!occurrence) {
        errors.push(`Folkedanserforeningens event ${sourceEventId} har et ugyldigt datointerval`);
        return;
      }

      let sourceUrl: string;
      try {
        sourceUrl = sameOriginHttpsUrl(absoluteUrl(href, pageUrl), FOLKEDANS_ORIGIN);
      } catch (error) {
        errors.push(
          `Folkedanserforeningens event ${sourceEventId} har et usikkert link: ${errorMessage(error)}`,
        );
        return;
      }
      const locationItem = card.find(".event-meta li:has(i[data-icon-name='map-marker'])").first();
      const location = parseLocation(textWithoutIcon(locationItem));
      const price = cleanText(card.find("[data-rel='multiCurrency']").first().text());
      const description = cleanText(card.find(".event-content > p").first().text());
      const statusText = cleanText(`${title} ${card.find(".badge, [class*='status']").text()}`);
      const cancelled = /\baflyst\b/i.test(statusText);
      const postponed = !cancelled && /\b(?:udskudt|udsat|flyttet)\b/i.test(statusText);
      const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/i.test(statusText);
      const bookingAnchor = card.find("a[href]").filter((_anchorIndex, anchorElement) => {
        const anchor = $(anchorElement);
        return /tilmeld|book|billet/i.test(`${anchor.text()} ${anchor.attr("href") ?? ""}`);
      }).first();
      const bookingUrl = secureUrl(bookingAnchor.attr("href"), pageUrl);
      if (bookingAnchor.length > 0 && !bookingUrl) {
        warnings.push(`Folkedanserforeningens event ${sourceEventId} har et usikkert tilmeldingslink`);
      }

      const reviewReasons: string[] = [];
      const ordering = chronology(occurrence);
      let normalizedOccurrence = occurrence;
      if (ordering === 0) {
        // Site123 sometimes repeats the start value in its end-time field. The
        // start is still explicit and stable, so preserve it and treat the
        // duplicated end value as an omitted duration.
        normalizedOccurrence = {
          id: occurrence.id,
          date: occurrence.date,
          ...(occurrence.startTime ? { startTime: occurrence.startTime } : {}),
          allDay: occurrence.allDay,
          timeUnknown: occurrence.timeUnknown,
        };
        warnings.push(
          `Folkedanserforeningens event ${sourceEventId} har ens start- og sluttid; sluttidspunktet blev udeladt`,
        );
      } else if (ordering > 0) {
        reviewReasons.push("Sluttidspunktet ligger før starttidspunktet på kildesiden");
      }
      const retrievedDate = DateTime.fromISO(retrievedAt, { setZone: true })
        .setZone("Europe/Copenhagen")
        .toISODate();
      if (retrievedDate && occurrence.date < retrievedDate) {
        reviewReasons.push("Eventen står som kommende, men datoen ligger før indsamlingstidspunktet");
      }
      if (!location) reviewReasons.push("Folkedanserforeningen oplyser ikke et sted");

      const candidate: NormalizedEventDraft = {
        sourceId: definition.id,
        sourceEventId,
        stableId: `${definition.id}-${sourceEventId}`,
        title,
        ...(description ? { description } : {}),
        organizerId: definition.organizerId,
        categoryIds: [...definition.categoryIds],
        ...(location ? { location } : {}),
        occurrences: [normalizedOccurrence],
        status: cancelled ? "cancelled" : postponed ? "postponed" : "scheduled",
        availability: soldOut ? "sold-out" : "unknown",
        attendance: bookingUrl ? "registration" : "public",
        ...(price ? { price } : {}),
        ...(bookingUrl ? { bookingUrl, bookingRequired: true } : {}),
        publication: reviewReasons.length > 0 ? "review" : "trusted",
        reviewReasons,
        provenance: {
          sourceId: definition.id,
          externalId: sourceEventId,
          sourceUrl,
          retrievedAt,
        },
      };

      const previous = candidatesById.get(sourceEventId);
      if (previous) {
        const signature = (value: NormalizedEventDraft) => JSON.stringify({
          title: value.title,
          description: value.description,
          location: value.location,
          occurrences: value.occurrences,
          status: value.status,
          price: value.price,
          sourceUrl: value.provenance.sourceUrl,
        });
        if (signature(previous) !== signature(candidate)) {
          errors.push(`Site123 gengav event ${sourceEventId} med modstridende oplysninger`);
        }
      } else {
        candidatesById.set(sourceEventId, candidate);
      }
    });
  });

  const collapsed = collapseAdultSeries([...candidatesById.values()], warnings);
  return {
    candidates: collapsed.candidates,
    excludedSourceEventIds: collapsed.excludedSourceEventIds,
    warnings,
    errors,
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: FOLKEDANS_ORIGIN,
    });
    const parsed = parseFolkedansPage(html, retrievedAt, definition.url);
    if (parsed.candidates.length === 0) {
      parsed.errors.push("Folkedanserforeningen returnerede ingen kommende events; snapshot beholdes");
    }
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: [...new Set(parsed.errors)],
        warnings: [...new Set(parsed.warnings)],
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      excludedSourceEventIds: parsed.excludedSourceEventIds,
      errors: [],
      warnings: [...new Set(parsed.warnings)],
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

export const folkedansSource: SourceAdapter = { definition, collect };
