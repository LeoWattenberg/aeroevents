import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, deduplicateBy, plainText, slug } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-bibliotek"];
const COPENHAGEN = "Europe/Copenhagen";
const MAX_LISTING_PAGES = 50;
const LIBRARY_ORIGIN = new URL(definition.url).origin;

export interface LibraryListingItem {
  url: string;
  title: string;
}

export interface LibraryListingResult {
  items: LibraryListingItem[];
  nextUrl?: string;
  warnings: string[];
  errors: string[];
}

export interface LibraryDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function parseDateTime(value: string): { date: string; time?: string } | undefined {
  const trimmed = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { date: trimmed };
  const parsed = DateTime.fromISO(trimmed, { setZone: true }).setZone(COPENHAGEN);
  if (!parsed.isValid) return undefined;
  return { date: parsed.toISODate()!, time: parsed.toFormat("HH:mm") };
}

function parseInterval(value: string): ExplicitOccurrenceDraft | undefined {
  const [startValue, endValue, ...extra] = cleanText(value).split("/");
  if (!startValue || extra.length > 0) return undefined;
  const start = parseDateTime(startValue);
  const end = endValue ? parseDateTime(endValue) : undefined;
  if (!start || (endValue && !end)) return undefined;
  const allDay = start.time === undefined;
  return {
    id: "placeholder",
    date: start.date,
    ...(start.time ? { startTime: start.time } : {}),
    ...(end ? { endDate: end.date } : {}),
    ...(end?.time ? { endTime: end.time } : {}),
    allDay,
    timeUnknown: false,
  };
}

function valueForLabel(
  $: ReturnType<typeof load>,
  label: string,
): ReturnType<ReturnType<typeof load>> {
  const term = $(".hero__items dt").filter(
    (_index, element) =>
      cleanText($(element).text()).toLocaleLowerCase("da-DK") ===
      label.toLocaleLowerCase("da-DK"),
  );
  return term.first().next("dd");
}

function sourceEventIdFromPage(
  $: ReturnType<typeof load>,
  sourceUrl: string,
): string {
  const settings = $("script[data-drupal-selector='drupal-settings-json']").first().html();
  if (settings) {
    try {
      const parsed = JSON.parse(settings) as { path?: { currentPath?: unknown } };
      if (typeof parsed.path?.currentPath === "string") {
        const id = parsed.path.currentPath.match(/(?:^|\/)events\/(\d+)(?:\/|$)/)?.[1];
        if (id) return id;
      }
    } catch {
      // The URL below remains deterministic; malformed settings is reported by
      // the caller only when the page itself cannot otherwise be normalized.
    }
  }
  const path = new URL(sourceUrl).pathname.replace(/\/$/, "");
  return slug(path.split("/").pop() ?? path);
}

function parseLocation(
  $: ReturnType<typeof load>,
): EventLocationDraft | undefined {
  const value = valueForLabel($, "Sted");
  if (value.length === 0) return undefined;
  const location: EventLocationDraft = {};
  const name = cleanText(value.find("span").first().text());
  const addressText = cleanText(value.find("address").text());
  if (name) location.name = name;
  if (addressText) {
    const match = addressText.match(/^(.*?)[,\s]+(\d{4})\s+(.+)$/);
    if (match?.[1] && match[2] && match[3]) {
      location.address = cleanText(match[1].replace(/,$/, ""));
      location.postalCode = match[2];
      location.city = cleanText(match[3]);
    } else {
      location.address = addressText;
    }
  }
  return Object.keys(location).length > 0 ? location : undefined;
}

export function parseLibraryListing(
  html: string,
  pageUrl: string,
): LibraryListingResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: LibraryListingItem[] = [];
  const wrapper = $("[data-drupal-views-infinite-scroll-content-wrapper]").first();
  if (wrapper.length === 0) {
    errors.push("Bibliotekets arrangementsliste mangler den forventede resultatblok");
    return { items, warnings, errors };
  }

  wrapper.find("li.content-list__item").each((index, element) => {
    const anchor = $(element).find("a.content-list-item[href]").first();
    const href = anchor.attr("href");
    const title = cleanText(anchor.find(".content-list-item__title").first().text());
    if (!href || !title) {
      errors.push(`Bibliotekets listeelement ${index + 1} mangler link eller titel`);
      return;
    }
    try {
      items.push({
        url: sameOriginHttpsUrl(absoluteUrl(href, pageUrl), LIBRARY_ORIGIN),
        title,
      });
    } catch (error) {
      errors.push(
        `Bibliotekets listeelement ${index + 1} har et usikkert link: ${errorMessage(error)}`,
      );
    }
  });

  const unique = deduplicateBy(items, (item) => item.url);
  if (unique.length !== items.length) {
    warnings.push("Bibliotekets side indeholdt det samme arrangementslink flere gange");
  }
  const nextHref = $("a[rel='next'][href], .pager__item--next a[href]").first().attr("href");
  let nextUrl: string | undefined;
  if (nextHref) {
    try {
      nextUrl = sameOriginHttpsUrl(absoluteUrl(nextHref, pageUrl), LIBRARY_ORIGIN);
    } catch (error) {
      errors.push(`Bibliotekets næste-side-link er usikkert: ${errorMessage(error)}`);
    }
  }
  return {
    items: unique,
    ...(nextUrl ? { nextUrl } : {}),
    warnings,
    errors,
  };
}

export function parseLibraryDetail(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
): LibraryDetailResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const title = cleanText($("h1.hero__title, article h1").first().text());
  const intervalValue = $(".hero__date time[datetime*='/'], article time[datetime*='/']")
    .last()
    .attr("datetime");
  const occurrence = intervalValue ? parseInterval(intervalValue) : undefined;
  const sourceEventId = sourceEventIdFromPage($, sourceUrl);

  if (!title) errors.push("Bibliotekets arrangementsside mangler titel");
  if (!sourceEventId) errors.push("Bibliotekets arrangementsside mangler stabilt id");
  if (!occurrence) errors.push("Bibliotekets arrangementsside mangler gyldigt datointerval");
  if (errors.length > 0 || !title || !sourceEventId || !occurrence) {
    return { warnings, errors };
  }

  occurrence.id = `bibliotek-${sourceEventId}`;
  const location = parseLocation($);
  const descriptionSections = [
    $(".event-description__description").first(),
    $("article .paragraphs .rich-text").first(),
  ];
  const descriptions = descriptionSections
    .filter((section) => section.length > 0)
    .map((section) => plainText($, section))
    .filter(Boolean);
  const description = [...new Set(descriptions)].join("\n\n");
  const priceValue = valueForLabel($, "Pris");
  const price = cleanText(
    priceValue.find("[data-ticket-price]").first().attr("data-ticket-price") ??
      priceValue.text(),
  );
  const bookingHref = $(".hero__cta a[href]").first().attr("href");
  const articleText = cleanText($("article").text());
  const statusText = cleanText(
    $("article .status-label, article .status-badge, article [class*='event-status']").text(),
  );
  const cancelled = /\baflyst\b/i.test(`${title} ${statusText} ${articleText}`);
  const soldOut = /\budsolgt\b/i.test(`${statusText} ${articleText}`);

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
      occurrences: [occurrence],
      status: cancelled ? "cancelled" : "scheduled",
      availability: soldOut ? "sold-out" : "available",
      attendance: "public",
      ...(price ? { price } : {}),
      ...(bookingHref ? { bookingUrl: absoluteUrl(bookingHref, sourceUrl) } : {}),
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl,
        retrievedAt,
      },
    },
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const listingItems: LibraryListingItem[] = [];
  const visitedPages = new Set<string>();
  let pageUrl: string | undefined = definition.url;
  let pagesFetched = 0;

  try {
    while (pageUrl) {
      if (visitedPages.has(pageUrl)) {
        errors.push("Bibliotekets pagination dannede en løkke");
        break;
      }
      if (visitedPages.size >= MAX_LISTING_PAGES) {
        errors.push(`Bibliotekets pagination oversteg ${MAX_LISTING_PAGES} sider`);
        break;
      }
      visitedPages.add(pageUrl);
      const html = await fetchText(context, pageUrl, { expectedOrigin: LIBRARY_ORIGIN });
      pagesFetched += 1;
      const parsed = parseLibraryListing(html, pageUrl);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors);
      listingItems.push(...parsed.items);
      if (parsed.errors.length > 0) break;
      pageUrl = parsed.nextUrl;
    }

    if (listingItems.length === 0) {
      errors.push("Biblioteket returnerede ingen arrangementer; snapshot beholdes");
    }

    const uniqueItems = deduplicateBy(listingItems, (item) => item.url);
    if (uniqueItems.length !== listingItems.length) {
      warnings.push("Et biblioteksarrangement forekom på flere listesider");
    }
    const candidates: NormalizedEventDraft[] = [];
    if (errors.length === 0) {
      for (const item of uniqueItems) {
        try {
          const detailHtml = await fetchText(context, item.url, {
            expectedOrigin: LIBRARY_ORIGIN,
          });
          pagesFetched += 1;
          const parsed = parseLibraryDetail(detailHtml, item.url, retrievedAt);
          warnings.push(...parsed.warnings);
          errors.push(...parsed.errors);
          if (parsed.candidate) candidates.push(parsed.candidate);
        } catch (error) {
          errors.push(`${item.url}: ${errorMessage(error)}`);
          break;
        }
      }
    }

    const ids = candidates.map((candidate) => candidate.sourceEventId);
    if (new Set(ids).size !== ids.length) {
      errors.push("Biblioteket returnerede samme arrangements-id flere gange");
    }
    if (candidates.length !== uniqueItems.length && errors.length === 0) {
      errors.push("Ikke alle biblioteksarrangementer kunne aflæses");
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

export const librarySource: SourceAdapter = { definition, collect };
