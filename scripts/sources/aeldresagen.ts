import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, deduplicateBy, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  Attendance,
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeldresagen-aeroe"];
const AELDRESAGEN_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";

export interface AeldresagenListingItem {
  id: string;
  title: string;
  url: string;
}

export interface AeldresagenListingResult {
  items: AeldresagenListingItem[];
  declaredCount?: number;
  warnings: string[];
  errors: string[];
}

export interface AeldresagenDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function textWithBreaks(
  element: ReturnType<ReturnType<typeof load>>,
): string {
  const clone = element.clone();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function activityId(url: string): string | undefined {
  return new URL(url).pathname.match(/\/(\d+)(?:-[^/]*)?\/?$/)?.[1];
}

function parseTime(hourValue: string, minuteValue?: string): string | undefined {
  const hour = Number(hourValue);
  const minute = Number(minuteValue ?? "0");
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseOccurrence(
  value: string,
  id: string,
): { occurrence?: ExplicitOccurrenceDraft; recurring: boolean; timeUnknown: boolean } {
  const recurring = /\b(?:alle\s+uger|ugedag|næste\s+forekomst)\b/i.test(value);
  const nextOccurrenceIndex = value.search(/\bnæste\s+forekomst\s*:/i);
  // A repeating activity is safe only when the source itself anchors a full
  // next occurrence. Never infer a future date from the generic weekday rule.
  if (recurring && nextOccurrenceIndex < 0) {
    return { recurring, timeUnknown: true };
  }
  const occurrenceText = recurring ? value.slice(nextOccurrenceIndex) : value;
  const dates = [...occurrenceText.matchAll(/(\d{1,2})\.(\d{1,2})\.(20\d{2})/g)];
  const dateMatch = dates.at(-1);
  if (!dateMatch?.[1] || !dateMatch[2] || !dateMatch[3]) {
    return { recurring, timeUnknown: true };
  }
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  if (!validCalendarDate(year, month, day)) {
    return { recurring, timeUnknown: true };
  }

  const weekdayMatch = occurrenceText.match(
    /\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\s+(?:d\.\s*)?\d{1,2}\.\d{1,2}\.20\d{2}/i,
  );
  const weekdayNames = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  if (
    weekdayMatch?.[1] &&
    weekdayNames[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !==
      weekdayMatch[1].toLocaleLowerCase("da-DK")
  ) {
    return { recurring, timeUnknown: true };
  }

  const ranges = [...occurrenceText.matchAll(
    /(?:kl\.?\s*)?(\d{1,2})(?:[.:](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?/gi,
  )];
  const range = ranges.at(-1);
  let startTime: string | undefined;
  let endTime: string | undefined;
  if (range?.[1] && range[3]) {
    startTime = parseTime(range[1], range[2]);
    endTime = parseTime(range[3], range[4]);
  } else {
    const singles = [...occurrenceText.matchAll(/kl\.?\s*(\d{1,2})[.:](\d{2})/gi)];
    const single = singles.at(-1);
    if (single?.[1] && single[2]) startTime = parseTime(single[1], single[2]);
  }
  const date = isoDate(year, month, day);
  return {
    occurrence: {
      id: `aeldresagen-${id}`,
      date,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endDate: date, endTime } : {}),
      allDay: false,
      timeUnknown: startTime === undefined,
    },
    recurring,
    timeUnknown: startTime === undefined,
  };
}

function valueAfterHeading(
  $: ReturnType<typeof load>,
  rootSelector: string,
  heading: string,
): string {
  const headingElement = $(rootSelector).find("h2").filter((_index, element) =>
    cleanText($(element).text()).toLocaleLowerCase("da-DK") ===
      heading.toLocaleLowerCase("da-DK")
  ).first();
  return headingElement.length > 0 ? cleanText(headingElement.next("p").text()) : "";
}

function descriptionFromPage($: ReturnType<typeof load>): string {
  const article = $("section.activity .deals-view__article__content").first();
  const heading = article.find("h2").filter((_index, element) =>
    cleanText($(element).text()).toLocaleLowerCase("da-DK") === "beskrivelse"
  ).first();
  if (heading.length === 0) return cleanText($(".page-headline .a-manchet").first().text());
  const lines = heading.nextUntil("h2").map((_index, element) =>
    cleanText($(element).text())
  ).get().filter(Boolean);
  return lines.join("\n") || cleanText($(".page-headline .a-manchet").first().text());
}

function parseAttendance(audience: string, bookingRequired: boolean): Attendance {
  if (/for alle|ikke-medlem/i.test(audience)) {
    return bookingRequired ? "registration" : "public";
  }
  if (/medlem/i.test(audience)) return "members";
  return bookingRequired ? "registration" : "unknown";
}

function parseLocation(value: string): EventLocationDraft | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map(cleanText).filter(Boolean);
  const name = parts[0];
  if (!name) return undefined;
  if (parts.length === 1) return { name };
  const location: EventLocationDraft = { name };
  if (parts[1]) location.address = parts[1];
  const tail = parts.slice(2).join(", ");
  const postal = tail.match(/(?:^|\s)(\d{4})\s+(.+)$/);
  if (postal?.[1] && postal[2]) {
    location.postalCode = postal[1];
    location.city = cleanText(postal[2]);
  } else if (tail) {
    location.city = tail;
  }
  return location;
}

function matchingLines(value: string, pattern: RegExp): string | undefined {
  const lines = value.split("\n").map(cleanText).filter((line) => pattern.test(line));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function secureUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const resolved = new URL(value, baseUrl);
  return resolved.protocol === "https:" ? resolved.toString() : undefined;
}

export function parseAeldresagenListing(
  html: string,
  pageUrl = definition.url,
): AeldresagenListingResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: AeldresagenListingItem[] = [];
  const lists = $("section.common-list.js-activity-list");
  if (lists.length !== 1) {
    errors.push(
      lists.length === 0
        ? "Ældre Sagen-siden mangler den forventede aktivitetsliste"
        : "Ældre Sagen-siden indeholder flere aktivitetslister end forventet",
    );
    return { items, warnings, errors };
  }
  const list = lists.first();
  const countText = cleanText(list.find(".js-activity-result-amount").first().text());
  const declaredCount = /^\d+$/.test(countText) ? Number(countText) : undefined;
  if (declaredCount === undefined) {
    errors.push("Ældre Sagen-siden mangler et gyldigt resultatantal");
  }
  const resultLists = list.find("ul.js-activity-result-list");
  if (resultLists.length !== 1) {
    errors.push("Ældre Sagen-siden mangler én entydig resultatblok");
    return { items, ...(declaredCount !== undefined ? { declaredCount } : {}), warnings, errors };
  }

  resultLists.first().children("li.o-list-cards__item").each((index, element) => {
    const anchor = $(element).find("a.o-list-card[href]").first();
    const title = cleanText(anchor.find(".o-list-card__heading").first().text());
    const href = anchor.attr("href");
    if (!href || !title) {
      errors.push(`Ældre Sagens listeelement ${index + 1} mangler link eller titel`);
      return;
    }
    try {
      const url = sameOriginHttpsUrl(absoluteUrl(href, pageUrl), AELDRESAGEN_ORIGIN);
      const id = activityId(url);
      if (!id) {
        errors.push(`Ældre Sagens listeelement ${index + 1} mangler numerisk aktivitets-id`);
        return;
      }
      items.push({ id, title, url });
    } catch (error) {
      errors.push(
        `Ældre Sagens listeelement ${index + 1} har et usikkert link: ${errorMessage(error)}`,
      );
    }
  });

  const unique = deduplicateBy(items, (item) => item.id);
  if (unique.length !== items.length) {
    errors.push("Ældre Sagen-siden gentog et aktivitets-id");
  }
  if (declaredCount !== undefined && unique.length !== declaredCount) {
    errors.push(
      `Ældre Sagen oplyste ${declaredCount} resultater, men ${unique.length} blev fundet i HTML-siden`,
    );
  }
  return {
    items: unique,
    ...(declaredCount !== undefined ? { declaredCount } : {}),
    warnings,
    errors,
  };
}

export function parseAeldresagenDetail(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
): AeldresagenDetailResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const activitySections = $("section.activity");
  const title = cleanText($(".page-headline h1.a-headline--xxxlarge").first().text());
  const canonical = $("link[rel='canonical']").first().attr("href");
  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = canonical
      ? sameOriginHttpsUrl(absoluteUrl(canonical, sourceUrl), AELDRESAGEN_ORIGIN)
      : undefined;
  } catch (error) {
    errors.push(`Ældre Sagens canonical-link er usikkert: ${errorMessage(error)}`);
  }
  const sourceEventId = activityId(canonicalUrl ?? sourceUrl);
  if (activitySections.length !== 1) errors.push("Ældre Sagens detaljeside mangler aktivitetsblokken");
  if (!title) errors.push("Ældre Sagens detaljeside mangler titel");
  if (!sourceEventId) errors.push("Ældre Sagens detaljeside mangler numerisk aktivitets-id");

  const whenHeading = $("section.activity .deals-view__details h2").filter((_index, element) =>
    cleanText($(element).text()).toLocaleLowerCase("da-DK") === "hvornår"
  ).first();
  const when = whenHeading.length > 0 ? textWithBreaks(whenHeading.parent()) : "";
  const parsedOccurrence = sourceEventId ? parseOccurrence(when, sourceEventId) : {
    recurring: false,
    timeUnknown: true,
  };
  if (!whenHeading.length) errors.push("Ældre Sagens detaljeside mangler Hvornår-feltet");
  if (!parsedOccurrence.occurrence) errors.push("Ældre Sagens detaljeside mangler en gyldig dato");
  if (errors.length > 0 || !title || !sourceEventId || !parsedOccurrence.occurrence) {
    return { warnings, errors };
  }

  const audience = valueAfterHeading($, "section.activity .deals-view__details", "Hvem");
  const description = descriptionFromPage($);
  const bookingRequired = /\b(?:bindende\s+)?tilmeld(?:ing|es)\b/i.test(description);
  const attendance = parseAttendance(audience, bookingRequired);
  const meetingPlace = valueAfterHeading($, "section.activity .deals-view__article__content", "Mødested");
  const location = parseLocation(meetingPlace);
  const price = matchingLines(description, /\b(?:pris|betaling)\b.*\d.*\b(?:kr|kroner)\b/i);
  const bookingDetails = matchingLines(description, /\b(?:tilmeld|betaling)\w*/i);
  const bookingAnchor = $("section.activity a[href]").filter((_index, element) => {
    const anchor = $(element);
    return /tilmeld|book|nemtilmeld/i.test(`${anchor.text()} ${anchor.attr("href") ?? ""}`);
  }).first();
  const bookingUrl = secureUrl(bookingAnchor.attr("href"), sourceUrl);
  if (bookingAnchor.length > 0 && !bookingUrl) {
    warnings.push("Ældre Sagens tilmeldingslink bruger ikke HTTPS");
  }

  const statusText = cleanText(
    `${title} ${$("section.activity .badge, section.activity [class*='status'], .page-headline .alert-notification:not(.page-headline__topic)").text()}`,
  );
  const cancelled = /\baflyst\b/i.test(statusText);
  const postponed = !cancelled && /\b(?:udskudt|udsat|flyttet)\b/i.test(statusText);
  const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/i.test(`${statusText} ${description}`);
  const reviewReasons: string[] = [...warnings];
  if (parsedOccurrence.recurring) {
    // The detail page exposes one explicit "Næste forekomst" with a stable
    // activity id. Re-importing that authoritative value on every run is safe;
    // no recurrence rule has to be inferred locally.
    warnings.push("Kilden beskriver en gentagelse; næste eksplicitte forekomst er importeret");
  }
  if (parsedOccurrence.timeUnknown) {
    reviewReasons.push("Ældre Sagen oplyser ikke et sikkert starttidspunkt");
  }
  const retrievedDate = DateTime.fromISO(retrievedAt, { setZone: true })
    .setZone(COPENHAGEN)
    .toISODate();
  if (retrievedDate && parsedOccurrence.occurrence.date < retrievedDate) {
    reviewReasons.push(
      parsedOccurrence.recurring
        ? "Ældre Sagens næste forekomst ligger før indsamlingstidspunktet"
        : "Ældre Sagens aktivitetsdato ligger før indsamlingstidspunktet",
    );
  }
  if (attendance === "unknown") {
    reviewReasons.push("Ældre Sagens målgruppe kunne ikke omsættes til en sikker adgangstype");
  }
  if (!location) {
    // Location is optional in the canonical model and its absence does not
    // make the explicit date/time or activity identity ambiguous.
    warnings.push("Ældre Sagen oplyser ikke et mødested på detaljesiden");
  }

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
      occurrences: [parsedOccurrence.occurrence],
      status: cancelled ? "cancelled" : postponed ? "postponed" : "scheduled",
      availability: soldOut ? "sold-out" : "unknown",
      attendance,
      ...(audience ? { attendanceDetails: audience } : {}),
      ...(price ? { price } : {}),
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(bookingRequired ? { bookingRequired: true } : {}),
      ...(bookingDetails ? { bookingDetails } : {}),
      publication: reviewReasons.length > 0 ? "review" : "trusted",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: canonicalUrl ?? sourceUrl,
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
    const listingHtml = await fetchText(context, definition.url, {
      expectedOrigin: AELDRESAGEN_ORIGIN,
    });
    pagesFetched += 1;
    const listing = parseAeldresagenListing(listingHtml, definition.url);
    warnings.push(...listing.warnings);
    errors.push(...listing.errors);
    if (listing.items.length === 0) {
      errors.push("Ældre Sagen returnerede ingen aktiviteter; snapshot beholdes");
    }

    if (errors.length === 0) {
      for (const item of listing.items) {
        try {
          const detailHtml = await fetchText(context, item.url, {
            expectedOrigin: AELDRESAGEN_ORIGIN,
          });
          pagesFetched += 1;
          const detail = parseAeldresagenDetail(detailHtml, item.url, retrievedAt);
          warnings.push(...detail.warnings);
          errors.push(...detail.errors.map((message) => `${item.url}: ${message}`));
          if (detail.candidate) {
            if (detail.candidate.sourceEventId !== item.id) {
              errors.push(`${item.url}: aktivitets-id ændrede sig mellem liste og detalje`);
            }
            if (
              detail.candidate.title.toLocaleLowerCase("da-DK") !==
              item.title.toLocaleLowerCase("da-DK")
            ) {
              const reason = "Titlen på Ældre Sagens liste og detaljeside er forskellig";
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
    errors.push("Ældre Sagen returnerede samme aktivitets-id flere gange");
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

export const aeldresagenSource: SourceAdapter = { definition, collect };
