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

const definition = SOURCE_REGISTRY["aeroe-folkeuniversitet"];
const FUKO_ORIGIN = new URL(definition.url).origin;

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

export interface FolkeuniversitetListingItem {
  id: string;
  title: string;
  url: string;
  statusLabel?: string;
}

export interface FolkeuniversitetListingResult {
  items: FolkeuniversitetListingItem[];
  defaultPrice?: string;
  warnings: string[];
  errors: string[];
}

export interface FolkeuniversitetDetailOptions {
  statusLabel?: string;
  defaultPrice?: string;
}

export interface FolkeuniversitetDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function courseId(url: string): string | undefined {
  return new URL(url).pathname.match(/^\/kurser\/([^/]+)\/?$/)?.[1];
}

function parseDateTime(value: string): { date?: string; time?: string } {
  const match = cleanText(value).toLocaleLowerCase("da-DK").match(
    /(?:^|\s)(\d{1,2})\.?\s+([a-zæøå]+)\s+(20\d{2})(?:\s+kl\.?\s*(\d{1,2})[.:](\d{2}))?/i,
  );
  if (!match?.[1] || !match[2] || !match[3]) return {};
  const day = Number(match[1]);
  const month = MONTHS.get(match[2]);
  const year = Number(match[3]);
  if (!month || !validCalendarDate(year, month, day)) return {};
  let time: string | undefined;
  if (match[4] && match[5]) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (hour <= 23 && minute <= 59) {
      time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  return { date: isoDate(year, month, day), ...(time ? { time } : {}) };
}

function valueWithoutLabel(
  element: ReturnType<ReturnType<typeof load>>,
): string {
  const clone = element.clone();
  clone.find("label").remove();
  return cleanText(clone.text());
}

function descriptionFromPage($: ReturnType<typeof load>): string {
  const fields = $("#primary.page__kurser > .row > .col-md-8 > .data__item.my-3");
  const descriptions = fields.map((_index, element) => {
    const clone = $(element).clone();
    clone.find("br").replaceWith("\n");
    return clone
      .text()
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map(cleanText)
      .filter(Boolean)
      .join("\n");
  }).get().filter(Boolean);
  return descriptions[0] ?? "";
}

function locationFromPage($: ReturnType<typeof load>): EventLocationDraft | undefined {
  const heading = $("#primary.page__kurser .kurser__info .kurser__well b").filter((_index, element) =>
    cleanText($(element).text()).toLocaleLowerCase("da-DK").replace(/:$/, "") === "sted"
  ).first();
  const value = cleanText(heading.closest(".well__item").next(".well__item").text());
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

function secureUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  const resolved = new URL(value, baseUrl);
  return resolved.protocol === "https:" ? resolved.toString() : undefined;
}

function explicitPrice(description: string): string | undefined {
  return description
    .split("\n")
    .map(cleanText)
    .find((line) => !/x{2,}/i.test(line) && /\b(?:entr[eé]|pris)\b[^\n]*\d[^\n]*\bkr\.?/i.test(line));
}

function modifiedAtFromJsonLd($: ReturnType<typeof load>): string | undefined {
  for (const element of $("script[type='application/ld+json']").toArray()) {
    const raw = $(element).html();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const values: unknown[] = [parsed];
      while (values.length > 0) {
        const value = values.shift();
        if (Array.isArray(value)) {
          values.push(...value);
        } else if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          if (typeof record.dateModified === "string") {
            const date = DateTime.fromISO(record.dateModified, { setZone: true });
            if (date.isValid) return date.toUTC().toISO() ?? undefined;
          }
          values.push(...Object.values(record));
        }
      }
    } catch {
      // Other structural fields remain authoritative when unrelated JSON-LD drifts.
    }
  }
  return undefined;
}

export function parseFolkeuniversitetListing(
  html: string,
  pageUrl = definition.url,
): FolkeuniversitetListingResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: FolkeuniversitetListingItem[] = [];
  const roots = $("#primary.page__komite");
  if (roots.length !== 1) {
    errors.push(
      roots.length === 0
        ? "Folkeuniversitetets komitéside mangler den forventede programblok"
        : "Folkeuniversitetets komitéside indeholder flere programblokke end forventet",
    );
    return { items, warnings, errors };
  }
  const root = roots.first();
  const committeeTitle = cleanText(root.find("h1.page__title").first().text());
  if (!/ærø\s+folkeuniversitet/i.test(committeeTitle)) {
    errors.push("Folkeuniversitetets programblok tilhører ikke entydigt Ærø-komitéen");
  }
  const programColumn = root.children(".row").first().children(".col-md-8").first();
  if (programColumn.length !== 1) {
    errors.push("Folkeuniversitetets Ærø-program mangler programkolonnen");
    return { items, warnings, errors };
  }

  programColumn.children(".kursus.kursus__item").each((index, element) => {
    const card = $(element);
    const anchor = card.find("a[href] h3.kursus__titel").first().parent("a");
    const title = cleanText(anchor.find("h3.kursus__titel").text());
    const href = anchor.attr("href");
    const dateText = cleanText(card.find(".kursus__datetime").first().text());
    if (!href || !title || !dateText) {
      errors.push(`Folkeuniversitetets programkort ${index + 1} mangler link, titel eller dato`);
      return;
    }
    try {
      const url = sameOriginHttpsUrl(absoluteUrl(href, pageUrl), FUKO_ORIGIN);
      const id = courseId(url);
      if (!id) {
        errors.push(`Folkeuniversitetets programkort ${index + 1} mangler en kanonisk kursus-slug`);
        return;
      }
      const statusLabel = cleanText(card.find(".badge").first().text());
      items.push({ id, title, url, ...(statusLabel ? { statusLabel } : {}) });
    } catch (error) {
      errors.push(
        `Folkeuniversitetets programkort ${index + 1} har et usikkert link: ${errorMessage(error)}`,
      );
    }
  });

  const unique = deduplicateBy(items, (item) => item.id);
  if (unique.length !== items.length) errors.push("Folkeuniversitetet returnerede samme kursus-slug flere gange");
  const priceParagraph = root.find(".komite__info .komite__well p").filter((_index, element) =>
    /entr[eé]en er/i.test(cleanText($(element).text()))
  ).first();
  const priceText = cleanText(priceParagraph.text());
  const defaultPrice = priceText.match(/entr[eé]en er\s+(.+)$/i)?.[1];
  return {
    items: unique,
    ...(defaultPrice ? { defaultPrice } : {}),
    warnings,
    errors,
  };
}

export function parseFolkeuniversitetDetail(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
  options: FolkeuniversitetDetailOptions = {},
): FolkeuniversitetDetailResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const roots = $("#primary.page__kurser");
  const requestedId = courseId(sourceUrl);
  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = canonicalHref
      ? sameOriginHttpsUrl(absoluteUrl(canonicalHref, sourceUrl), FUKO_ORIGIN)
      : undefined;
  } catch (error) {
    errors.push(`Folkeuniversitetets canonical-link er usikkert: ${errorMessage(error)}`);
  }
  const sourceEventId = canonicalUrl ? courseId(canonicalUrl) : requestedId;
  const title = cleanText(roots.find("h1.page__title").first().text());
  if (roots.length !== 1) errors.push("Folkeuniversitetets detaljeside mangler kursusblokken");
  if (!sourceEventId || !requestedId) errors.push("Folkeuniversitetets detalje-URL mangler kursus-slug");
  if (sourceEventId && requestedId && sourceEventId !== requestedId) {
    errors.push("Folkeuniversitetets canonical-link peger på en anden kursus-slug");
  }
  if (!title) errors.push("Folkeuniversitetets detaljeside mangler titel");
  const timeField = roots.find(".data__item").filter((_index, element) =>
    cleanText($(element).find("label").first().text()).toLocaleLowerCase("da-DK").replace(/:$/, "") ===
      "tidspunkt"
  ).first();
  const parsedDateTime = parseDateTime(valueWithoutLabel(timeField));
  if (!parsedDateTime.date) errors.push("Folkeuniversitetets detaljeside mangler en gyldig dato");
  if (errors.length > 0 || !sourceEventId || !title || !parsedDateTime.date) {
    return { warnings, errors };
  }

  const description = descriptionFromPage($);
  const location = locationFromPage($);
  const price = explicitPrice(description) ?? options.defaultPrice;
  const bookingRequired = /\b(?:bindende\s+tilmelding|tilmelding\s+(?:er\s+)?(?:påkrævet|nødvendig)|tilmelding\s+senest)\b/i.test(description);
  const bookingDetails = bookingRequired
    ? description.split("\n").map(cleanText).find((line) => /\btilmeld/i.test(line))
    : undefined;
  const bookingAnchor = roots.find("a[href]").filter((_index, element) => {
    const anchor = $(element);
    return /tilmeld|book|billet/i.test(`${anchor.text()} ${anchor.attr("href") ?? ""}`);
  }).first();
  const bookingUrl = secureUrl(bookingAnchor.attr("href"), sourceUrl);
  if (bookingAnchor.length > 0 && !bookingUrl) {
    warnings.push("Folkeuniversitetets tilmeldingslink bruger ikke HTTPS");
  }
  const statusText = cleanText(`${options.statusLabel ?? ""} ${roots.find(".badge").text()}`);
  const cancelled = /\baflyst\b/i.test(statusText);
  const postponed = !cancelled && /\b(?:udskudt|udsat|flyttet)\b/i.test(statusText);
  const held = /\bafholdt\b/i.test(statusText);
  const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/i.test(statusText);
  const reviewReasons: string[] = [];
  if (!parsedDateTime.time) reviewReasons.push("Folkeuniversitetet oplyser ikke et sikkert starttidspunkt");
  if (!location) reviewReasons.push("Folkeuniversitetet oplyser ikke et sted");
  if (location && /sandsynligvis|forventet/i.test(JSON.stringify(location))) {
    reviewReasons.push("Folkeuniversitetet markerer selv stedet som usikkert");
  }
  if (held) {
    reviewReasons.push("Kilden markerer arrangementet som Afholdt; datamodellen har ingen afsluttet-status");
  }
  if (statusText && !cancelled && !postponed && !held && !soldOut) {
    reviewReasons.push(`Ukendt statusmærke fra Folkeuniversitetet: ${statusText}`);
  }
  reviewReasons.push(...warnings);
  const sourceModifiedAt = modifiedAtFromJsonLd($);

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
        id: `folkeuniversitet-${sourceEventId}`,
        date: parsedDateTime.date,
        ...(parsedDateTime.time ? { startTime: parsedDateTime.time } : {}),
        allDay: false,
        timeUnknown: parsedDateTime.time === undefined,
      }],
      status: cancelled ? "cancelled" : postponed ? "postponed" : "scheduled",
      availability: soldOut ? "sold-out" : "unknown",
      attendance: bookingRequired ? "registration" : "public",
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
        ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
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
      expectedOrigin: FUKO_ORIGIN,
    });
    pagesFetched += 1;
    const listing = parseFolkeuniversitetListing(listingHtml, definition.url);
    warnings.push(...listing.warnings);
    errors.push(...listing.errors);
    if (listing.items.length === 0) {
      errors.push("Folkeuniversitetets Ærø-program er tomt; snapshot beholdes");
    }
    if (errors.length === 0) {
      for (const item of listing.items) {
        try {
          const detailHtml = await fetchText(context, item.url, {
            expectedOrigin: FUKO_ORIGIN,
          });
          pagesFetched += 1;
          const detail = parseFolkeuniversitetDetail(detailHtml, item.url, retrievedAt, {
            ...(item.statusLabel ? { statusLabel: item.statusLabel } : {}),
            ...(listing.defaultPrice ? { defaultPrice: listing.defaultPrice } : {}),
          });
          warnings.push(...detail.warnings);
          errors.push(...detail.errors.map((message) => `${item.url}: ${message}`));
          if (detail.candidate) {
            if (detail.candidate.sourceEventId !== item.id) {
              errors.push(`${item.url}: kursus-slug ændrede sig mellem liste og detalje`);
            }
            if (
              detail.candidate.title.toLocaleLowerCase("da-DK") !==
              item.title.toLocaleLowerCase("da-DK")
            ) {
              const reason = "Titlen på Folkeuniversitetets liste og detaljeside er forskellig";
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
    errors.push("Folkeuniversitetet returnerede samme kursus-slug flere gange");
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

export const folkeuniversitetSource: SourceAdapter = { definition, collect };
