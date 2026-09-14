import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, deduplicateBy, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-kommune-events"];
const MUNICIPALITY_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";

const MONTHS = new Map<string, number>([
  ["januar", 1],
  ["februar", 2],
  ["marts", 3],
  ["april", 4],
  ["maj", 5],
  ["juni", 6],
  ["juli", 7],
  ["august", 8],
  ["september", 9],
  ["oktober", 10],
  ["november", 11],
  ["december", 12],
]);

const WEEKDAYS = new Map<string, number>([
  ["mandag", 1],
  ["tirsdag", 2],
  ["onsdag", 3],
  ["torsdag", 4],
  ["fredag", 5],
  ["lørdag", 6],
  ["søndag", 7],
]);

interface VisibleDanishDate {
  day: number;
  month: number;
  endDay?: number;
  weekday?: number;
}

export interface MunicipalityEventListingItem {
  url: string;
  title: string;
}

export interface MunicipalityEventsListingResult {
  items: MunicipalityEventListingItem[];
  warnings: string[];
  errors: string[];
}

export interface MunicipalityEventDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function eventItemForIcon(
  $: ReturnType<typeof load>,
  iconName: string,
) {
  return $(`section.eventinfobox bui-text-item.event-item:has(bui-icon[name='${iconName}'])`).first();
}

function textWithoutIcons(
  element: ReturnType<ReturnType<typeof load>>,
): string {
  const clone = element.clone();
  clone.find("bui-icon").remove();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function parseDanishDateRange(value: string): { date: string; endDate?: string } | undefined {
  const match = cleanText(value)
    .toLocaleLowerCase("da-DK")
    .match(/(?:^|\s)(\d{1,2})\.?(?:\s*[-–—]\s*(\d{1,2})\.?)?\s+([a-zæøå]+)\s+(20\d{2})(?:\b|[.,])/i);
  if (!match?.[1] || !match[3] || !match[4]) return undefined;
  const day = Number(match[1]);
  const endDay = match[2] ? Number(match[2]) : undefined;
  const month = MONTHS.get(match[3]);
  const year = Number(match[4]);
  if (!month || !validCalendarDate(year, month, day)) return undefined;
  if (endDay !== undefined && !validCalendarDate(year, month, endDay)) return undefined;
  return {
    date: isoDate(year, month, day),
    ...(endDay !== undefined ? { endDate: isoDate(year, month, endDay) } : {}),
  };
}

function parseVisibleDanishDate(value: string): VisibleDanishDate | undefined {
  const match = cleanText(value)
    .toLocaleLowerCase("da-DK")
    .match(
      /\b(?:(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\s+(?:den\s+)?)?(\d{1,2})\.?(?:\s*[-–—]\s*(\d{1,2})\.?)?\s+([a-zæøå]+)/i,
    );
  if (!match?.[2] || !match[4]) return undefined;
  const day = Number(match[2]);
  const endDay = match[3] ? Number(match[3]) : undefined;
  const month = MONTHS.get(match[4]);
  if (!month || day < 1 || day > 31) return undefined;
  const weekday = match[1] ? WEEKDAYS.get(match[1]) : undefined;
  return {
    day,
    month,
    ...(endDay !== undefined ? { endDay } : {}),
    ...(weekday ? { weekday } : {}),
  };
}

function parseCmsInstant(value: string | undefined): DateTime | undefined {
  if (!value) return undefined;
  for (const format of ["yyyy-MM-dd HH.mm", "yyyy-MM-dd HH:mm"]) {
    const parsed = DateTime.fromFormat(cleanText(value), format, { zone: COPENHAGEN });
    if (parsed.isValid) return parsed;
  }
  return undefined;
}

function inferDateFromPublicationWindow(
  metaDescription: string,
  dateText: string,
  activeToValue: string | undefined,
  retrievedAt: string,
): { date: string } | undefined {
  const metaDate = parseVisibleDanishDate(metaDescription);
  const boxDate = parseVisibleDanishDate(dateText);
  const activeTo = parseCmsInstant(activeToValue);
  const retrieved = DateTime.fromISO(retrievedAt, { setZone: true }).setZone(COPENHAGEN);
  if (
    !metaDate ||
    !boxDate ||
    !metaDate.weekday ||
    !boxDate.weekday ||
    !activeTo ||
    !retrieved.isValid ||
    metaDate.endDay !== undefined ||
    boxDate.endDay !== undefined ||
    metaDate.day !== boxDate.day ||
    metaDate.month !== boxDate.month
  ) {
    return undefined;
  }

  const inferred = [activeTo.startOf("day"), activeTo.startOf("day").minus({ days: 1 })].find(
    (candidate) => candidate.month === boxDate.month && candidate.day === boxDate.day,
  );
  if (
    !inferred ||
    inferred.weekday !== metaDate.weekday ||
    inferred.weekday !== boxDate.weekday ||
    inferred.startOf("day") < retrieved.startOf("day")
  ) {
    return undefined;
  }
  return { date: inferred.toISODate()! };
}

function parseClockRange(value: string): { startTime: string; endTime?: string } | undefined {
  const match = cleanText(value).match(
    /(?:klokken|kl\.?)?\s*(\d{1,2})[.:](\d{2})(?:\s*[-–—]\s*(\d{1,2})[.:](\d{2}))?/i,
  );
  if (!match?.[1] || !match[2]) return undefined;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = match[3] ? Number(match[3]) : undefined;
  const endMinute = match[4] ? Number(match[4]) : undefined;
  if (
    startHour > 23 ||
    startMinute > 59 ||
    (endHour !== undefined && endHour > 23) ||
    (endMinute !== undefined && endMinute > 59)
  ) {
    return undefined;
  }
  return {
    startTime: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
    ...(endHour !== undefined && endMinute !== undefined
      ? {
          endTime: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
        }
      : {}),
  };
}

function parseLocation(value: string): EventLocationDraft | undefined {
  const lines = value.split("\n").map(cleanText).filter(Boolean);
  const name = lines[0];
  if (!name) return undefined;
  if (lines[1] && /\d/.test(name) && !/\d/.test(lines[1])) {
    return { name, city: lines[1] };
  }
  const location: EventLocationDraft = { name };
  if (lines[1]) {
    const postal = lines[1].match(/^(.*?)[,\s]+(\d{4})\s+(.+)$/);
    const city = lines[1].match(/^(.*?),\s*([^,]+)$/);
    if (postal?.[1] && postal[2] && postal[3]) {
      location.address = cleanText(postal[1]);
      location.postalCode = postal[2];
      location.city = cleanText(postal[3]);
    } else if (city?.[1] && city[2]) {
      location.address = cleanText(city[1]);
      location.city = cleanText(city[2]);
    } else {
      location.address = lines[1];
    }
  }
  if (lines.length > 2) {
    location.address = lines.slice(1).join(", ");
  }
  return location;
}

function secureBookingUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const resolved = new URL(value, baseUrl);
  return resolved.protocol === "https:" ? resolved.toString() : undefined;
}

function sourceModifiedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.fromFormat(cleanText(value), "yyyy-MM-dd HH.mm", {
    zone: "Europe/Copenhagen",
  });
  return parsed.isValid ? parsed.toUTC().toISO() ?? undefined : undefined;
}

export function parseMunicipalityEventsListing(
  html: string,
  pageUrl = definition.url,
): MunicipalityEventsListingResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: MunicipalityEventListingItem[] = [];
  const grids = $("bui-section-grid.itemlist-events");
  if (grids.length !== 1) {
    errors.push(
      grids.length === 0
        ? "Kommunens Det sker-side mangler den forventede arrangementsliste"
        : "Kommunens Det sker-side indeholder flere arrangementslister end forventet",
    );
    return { items, warnings, errors };
  }

  grids.first().find("article").each((index, element) => {
    const anchor = $(element).find("a[property='url'][href]").first();
    const title = cleanText(anchor.find("bui-event-card [slot='heading']").first().text());
    const href = anchor.attr("href");
    if (!href || !title) {
      errors.push(`Kommunens listeelement ${index + 1} mangler link eller titel`);
      return;
    }
    try {
      items.push({
        title,
        url: sameOriginHttpsUrl(absoluteUrl(href, pageUrl), MUNICIPALITY_ORIGIN),
      });
    } catch (error) {
      errors.push(
        `Kommunens listeelement ${index + 1} har et usikkert link: ${errorMessage(error)}`,
      );
    }
  });

  const unique = deduplicateBy(items, (item) => item.url);
  if (unique.length !== items.length) {
    warnings.push("Kommunens Det sker-side gentog et arrangementslink");
  }
  return { items: unique, warnings, errors };
}

export function parseMunicipalityEventDetail(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
): MunicipalityEventDetailResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const title = cleanText($("main article h1, article h1").first().text());
  const sourceEventId = cleanText($("meta[name='pageid']").first().attr("content") ?? "");
  const infoBoxes = $("main article section.eventinfobox, article section.eventinfobox");
  const metaDescription = $("meta[name='description']").first().attr("content") ?? "";
  const dateText = textWithoutIcons(eventItemForIcon($, "calendar"));
  let dates = parseDanishDateRange(metaDescription);
  if (!dates) {
    dates = inferDateFromPublicationWindow(
      metaDescription,
      dateText,
      $("meta[name='cmspageactiveto']").first().attr("content"),
      retrievedAt,
    );
  }
  const visibleDate = parseVisibleDanishDate(dateText);
  const clock = parseClockRange(
    textWithoutIcons(eventItemForIcon($, "clock")) || dateText,
  );
  const metaClock = parseClockRange(metaDescription);
  const endItemText = textWithoutIcons(eventItemForIcon($, "calendar-check"));
  const endClock = endItemText ? parseClockRange(endItemText) : undefined;

  if (!title) errors.push("Kommunens arrangementsside mangler titel");
  if (!/^[a-z0-9-]{8,}$/i.test(sourceEventId)) {
    errors.push("Kommunens arrangementsside mangler et stabilt pageid");
  }
  if (infoBoxes.length !== 1) {
    errors.push("Kommunens arrangementsside mangler én entydig informationsboks");
  }
  if (!dates) errors.push("Kommunens arrangementsside mangler en gyldig dato med årstal");
  if (!clock) errors.push("Kommunens arrangementsside mangler et gyldigt starttidspunkt");
  if (
    clock &&
    metaClock &&
    (clock.startTime !== metaClock.startTime ||
      (clock.endTime && metaClock.endTime && clock.endTime !== metaClock.endTime))
  ) {
    errors.push("Tidspunktet i kommunens informationsboks stemmer ikke med sidens metadata");
  }
  if (dates && visibleDate) {
    const [, month, day] = dates.date.split("-").map(Number);
    if (
      visibleDate.day !== day ||
      visibleDate.month !== month
    ) {
      errors.push("Datoen i kommunens informationsboks stemmer ikke med sidens metadata");
    }
    const parsedDate = DateTime.fromISO(dates.date, { zone: COPENHAGEN });
    if (visibleDate.weekday && parsedDate.isValid && visibleDate.weekday !== parsedDate.weekday) {
      errors.push("Ugedagen i kommunens informationsboks stemmer ikke med datoen");
    }
  }
  if (errors.length > 0 || !title || !dates || !clock) {
    return { warnings, errors };
  }

  const descriptionElement = $("main article section.richtext bui-base.richtext, article section.richtext bui-base.richtext").first();
  const description = descriptionElement.length > 0
    ? textWithoutIcons(descriptionElement)
    : undefined;
  const locationText = textWithoutIcons(eventItemForIcon($, "location-dot"));
  const location = parseLocation(locationText);
  if (!location) {
    warnings.push("Kommunens arrangement mangler sted");
  }
  const price = cleanText(
    textWithoutIcons(eventItemForIcon($, "coins")) ||
      textWithoutIcons(eventItemForIcon($, "sack")),
  );
  const statusText = cleanText(
    `${title} ${$("section.eventinfobox [class*='status'], section.eventinfobox .badge").text()}`,
  );
  const descriptionStart = description?.slice(0, 160) ?? "";
  const cancelled = /\baflyst\b/i.test(statusText) || /^(?:arrangementet er\s+)?aflyst\b/i.test(descriptionStart);
  const postponed = !cancelled && (
    /\b(?:udskudt|udsat)\b/i.test(statusText) ||
    /^(?:arrangementet er\s+)?(?:udskudt|udsat)\b/i.test(descriptionStart)
  );
  const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/i.test(`${statusText} ${descriptionStart}`);
  const bookingRequired = /\b(?:bindende\s+)?tilmeld(?:ing|es)\b/i.test(description ?? "");
  const bookingAnchor = descriptionElement.find("a[href]").filter((_index, element) => {
    const anchor = $(element);
    return /tilmeld|billet|book/i.test(`${anchor.text()} ${anchor.attr("href") ?? ""}`);
  }).first();
  const bookingUrl = secureBookingUrl(bookingAnchor.attr("href"), sourceUrl);
  if (bookingAnchor.length > 0 && !bookingUrl) {
    warnings.push("Kommunens tilmeldingslink bruger ikke HTTPS");
  }
  const modifiedAt = sourceModifiedAt($("meta[name='cmspageupdated']").attr("content"));
  const reviewReasons = [...warnings];
  const endDate = dates.endDate ?? (clock.endTime || endClock ? dates.date : undefined);
  const endTime = endClock?.startTime ?? clock.endTime;

  return {
    warnings,
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(location ? { location } : {}),
      occurrences: [{
        id: `kommune-event-${sourceEventId}`,
        date: dates.date,
        startTime: clock.startTime,
        ...(endDate ? { endDate } : {}),
        ...(endTime ? { endTime } : {}),
        allDay: false,
        timeUnknown: false,
      }],
      status: cancelled ? "cancelled" : postponed ? "postponed" : "scheduled",
      availability: soldOut ? "sold-out" : "unknown",
      attendance: bookingRequired ? "registration" : "public",
      ...(price ? { price } : {}),
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(bookingRequired ? { bookingRequired: true } : {}),
      publication: reviewReasons.length > 0 ? "review" : "trusted",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl,
        retrievedAt,
        ...(modifiedAt ? { sourceModifiedAt: modifiedAt } : {}),
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
    const listingHtml = await fetchText(context, definition.url, {
      expectedOrigin: MUNICIPALITY_ORIGIN,
    });
    pagesFetched += 1;
    const listing = parseMunicipalityEventsListing(listingHtml, definition.url);
    warnings.push(...listing.warnings);
    errors.push(...listing.errors);
    if (listing.items.length === 0) {
      errors.push("Kommunens Det sker-side returnerede ingen arrangementer; snapshot beholdes");
    }

    if (errors.length === 0) {
      for (const item of listing.items) {
        try {
          const detailHtml = await fetchText(context, item.url, {
            expectedOrigin: MUNICIPALITY_ORIGIN,
          });
          pagesFetched += 1;
          const detail = parseMunicipalityEventDetail(detailHtml, item.url, retrievedAt);
          warnings.push(...detail.warnings);
          errors.push(...detail.errors.map((message) => `${item.url}: ${message}`));
          if (detail.candidate) {
            if (
              detail.candidate.title.toLocaleLowerCase("da-DK") !==
              item.title.toLocaleLowerCase("da-DK")
            ) {
              const reason = "Titlen på kommunens liste og detaljeside er forskellig";
              warnings.push(`${item.url}: ${reason}`);
              detail.candidate.publication = "review";
              detail.candidate.reviewReasons.push(reason);
            }
            candidates.push(detail.candidate);
          }
        } catch (error) {
          errors.push(`${item.url}: ${errorMessage(error)}`);
        }
      }
    }
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
    errors.push(errorMessage(error));
  }

  const ids = candidates.map((candidate) => candidate.sourceEventId);
  if (new Set(ids).size !== ids.length) {
    errors.push("Kommunens Det sker-side returnerede samme pageid flere gange");
  }
  if (errors.length === 0 && candidates.length === 0) {
    errors.push("Ingen kommunale arrangementer kunne aflæses; snapshot beholdes");
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
      discardedCandidateCount: candidates.length,
    };
  }
  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates,
    errors: [],
    warnings: [...new Set(warnings)],
  };
}

export const municipalityEventsSource: SourceAdapter = { definition, collect };
