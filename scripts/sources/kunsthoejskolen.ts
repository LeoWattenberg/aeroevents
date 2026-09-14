import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText, deduplicateBy, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["kunsthoejskolen-aeroe"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const LISTING_PURL = "for-og-efterårskurser";
const MAX_COURSES = 60;

interface CargoPage {
  id: string;
  title: string;
  purl: string;
  content: string;
  access_level?: string;
}

interface CargoState {
  site: { id: number; domain: string; website_title: string; access_level?: string };
  pages: { byId: Record<string, CargoPage> };
  frontendState: { activePID?: string };
}

export interface KunsthoejskolenListingItem {
  url: string;
  title: string;
  startDate: string;
  endDate: string;
  soldOut: boolean;
}

export interface KunsthoejskolenListingResult {
  items: KunsthoejskolenListingItem[];
  warnings: string[];
  errors: string[];
}

export interface KunsthoejskolenDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cargoState(html: string): CargoState | undefined {
  const $ = load(html);
  const script = $("script").toArray()
    .map((element) => $(element).html() ?? "")
    .find((value) => value.includes("window.__PRELOADED_STATE__"));
  if (!script) return undefined;
  const assignment = script.match(/window\.__PRELOADED_STATE__\s*=\s*([\s\S]+?)\s*;?\s*$/);
  if (!assignment?.[1]) return undefined;
  try {
    const value = record(JSON.parse(assignment[1]));
    const site = record(value?.site);
    const pages = record(value?.pages);
    const byId = record(pages?.byId);
    const frontendState = record(value?.frontendState);
    if (
      typeof site?.id !== "number" ||
      site.domain !== "kunstaeroe.dk" ||
      site.website_title !== "Kunsthøjskolen på Ærø" ||
      !byId ||
      !frontendState
    ) return undefined;
    const parsedPages: Record<string, CargoPage> = {};
    for (const [id, pageValue] of Object.entries(byId)) {
      const page = record(pageValue);
      if (
        page?.id !== id ||
        typeof page.title !== "string" ||
        typeof page.purl !== "string" ||
        typeof page.content !== "string"
      ) continue;
      parsedPages[id] = {
        id,
        title: cleanText(page.title),
        purl: page.purl,
        content: page.content,
        ...(typeof page.access_level === "string" ? { access_level: page.access_level } : {}),
      };
    }
    return {
      site: {
        id: site.id,
        domain: site.domain,
        website_title: site.website_title,
        ...(typeof site.access_level === "string" ? { access_level: site.access_level } : {}),
      },
      pages: { byId: parsedPages },
      frontendState: {
        ...(typeof frontendState.activePID === "string"
          ? { activePID: frontendState.activePID }
          : {}),
      },
    };
  } catch {
    return undefined;
  }
}

function dateRange(value: string): { startDate?: string; endDate?: string } {
  const match = cleanText(value).match(
    /(\d{1,2})\.(\d{1,2})\.\s*[–—-]\s*(\d{1,2})\.(\d{1,2})\.?\s*(20\d{2})/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return {};
  const startDay = Number(match[1]);
  const startMonth = Number(match[2]);
  const endDay = Number(match[3]);
  const endMonth = Number(match[4]);
  const endYear = Number(match[5]);
  const startYear = startMonth > endMonth ? endYear - 1 : endYear;
  if (
    !validCalendarDate(startYear, startMonth, startDay) ||
    !validCalendarDate(endYear, endMonth, endDay)
  ) return {};
  const startDate = isoDate(startYear, startMonth, startDay);
  const endDate = isoDate(endYear, endMonth, endDay);
  return startDate <= endDate ? { startDate, endDate } : {};
}

function detailUrl(href: string, pageUrl: string): string {
  const url = sameOriginHttpsUrl(new URL(href, pageUrl).toString(), SOURCE_ORIGIN);
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || parsed.pathname === "/") {
    throw new Error("kursuslinket har en uventet URL-form");
  }
  return url;
}

export function parseKunsthoejskolenListing(
  html: string,
  pageUrl = definition.url,
  now = new Date(0),
): KunsthoejskolenListingResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const state = cargoState(html);
  if (!state || state.site.access_level === "private") {
    return { items: [], warnings, errors: ["Kunsthøjskolens Cargo-sidemodel mangler eller tilhører ikke den forventede offentlige side"] };
  }
  const listingPages = Object.values(state.pages.byId).filter((page) => page.purl === LISTING_PURL);
  if (listingPages.length !== 1) {
    return {
      items: [], warnings,
      errors: [`Kunsthøjskolens Cargo-model indeholder ${listingPages.length} kursusoversigter; forventede præcis én`],
    };
  }

  const $ = load(listingPages[0]!.content);
  const items: KunsthoejskolenListingItem[] = [];
  const today = DateTime.fromJSDate(now, { zone: "Europe/Copenhagen" }).toISODate()!;
  $("media-item.linked[href]").each((index, element) => {
    const card = $(element);
    const href = card.attr("href");
    const title = cleanText(card.find("figcaption .brd2").last().text());
    const range = dateRange(card.text());
    if (!href || !title || !range.startDate || !range.endDate) {
      errors.push(`Kunsthøjskolens kursuskort ${index + 1} mangler link, titel eller datointerval`);
      return;
    }
    if (range.endDate < today) {
      warnings.push(`Kunsthøjskolens afsluttede kursus “${title}” blev udeladt`);
      return;
    }
    try {
      items.push({
        url: detailUrl(href, pageUrl),
        title,
        startDate: range.startDate,
        endDate: range.endDate,
        soldOut: /UDSOLGT/i.test(card.text()),
      });
    } catch (error) {
      errors.push(`Kunsthøjskolens kursuskort ${index + 1} har et usikkert link: ${errorMessage(error)}`);
    }
  });
  if ($("media-item.linked[href]").length === 0) {
    errors.push("Kunsthøjskolens kursusoversigt indeholder ingen genkendelige kursuskort");
  }
  if (items.length > MAX_COURSES) errors.push(`Kunsthøjskolen returnerede flere end ${MAX_COURSES} kurser`);
  const unique = deduplicateBy(items, (item) => item.url);
  if (unique.length !== items.length) errors.push("Kunsthøjskolen returnerede samme kursuslink flere gange");
  return { items: unique, warnings, errors };
}

function secureBookingUrl(value: string | undefined, sourceUrl: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value, sourceUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.webtilmeldinger.dk") return undefined;
  return url.toString();
}

export function parseKunsthoejskolenDetail(
  html: string,
  sourceUrl: string,
  expected: KunsthoejskolenListingItem,
  retrievedAt: string,
): KunsthoejskolenDetailResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const state = cargoState(html);
  if (!state || state.site.access_level === "private") {
    return { warnings, errors: ["Kunsthøjskolens kursusside mangler den forventede Cargo-sidemodel"] };
  }
  const pageId = state.frontendState.activePID;
  const page = pageId ? state.pages.byId[pageId] : undefined;
  if (!page || page.access_level === "private") {
    return { warnings, errors: ["Kunsthøjskolens aktive offentlige kursusside kan ikke identificeres"] };
  }
  let requestedPurl = "";
  try {
    requestedPurl = decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\/+|\/+$/g, ""));
  } catch {
    errors.push("Kunsthøjskolens kursus-URL kan ikke afkodes");
  }
  if (page.purl !== requestedPurl) errors.push("Kunsthøjskolens Cargo-side-ID matcher ikke det anmodede kursuslink");

  const $ = load(page.content);
  const range = dateRange($.root().text());
  if (!page.title || !range.startDate || !range.endDate) {
    errors.push("Kunsthøjskolens kursusside mangler titel eller gyldigt datointerval");
  }
  if (range.startDate && range.startDate !== expected.startDate || range.endDate && range.endDate !== expected.endDate) {
    errors.push("Kunsthøjskolens kursusdatoer er forskellige på oversigt og detaljeside");
  }
  const bookingHref = $("a.tilmelding[href]").filter((_index, element) =>
    /tilmelding/i.test(cleanText($(element).text())),
  ).first().attr("href");
  const bookingUrl = secureBookingUrl(bookingHref, sourceUrl);
  if (bookingHref && !bookingUrl) errors.push("Kunsthøjskolens tilmeldingslink er ikke et sikkert WebTilmeldinger-link");
  const soldOut = expected.soldOut || /UDSOLGT/i.test($.root().text());
  if (!soldOut && !bookingUrl) errors.push("Kunsthøjskolens ledige kursus mangler tilmeldingslink");
  if (errors.length > 0 || !range.startDate || !range.endDate) return { warnings, errors };

  const priceLine = cleanText($.root().text()).match(/\bPris\s+kr\.\s*[\d.]+(?:,[-\d]+)?/i)?.[0];
  const descriptionRoot = $("column-unit").first().clone();
  descriptionRoot.find("media-item, figcaption, a.tilmelding, hr").remove();
  const description = cleanText(descriptionRoot.text()).slice(0, 8_000);
  const canonicalSourceUrl = new URL(`/${encodeURI(page.purl)}`, SOURCE_ORIGIN).toString();
  const reviewReasons = page.title !== expected.title
    ? ["Kursustitlen er forskellig på oversigten og detaljesiden"]
    : [];
  return {
    warnings,
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId: page.id,
      stableId: `${definition.id}-${page.id}`,
      title: page.title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: {
        name: "Kunsthøjskolen på Ærø",
        address: "Vester Møllebakke 4",
        postalCode: "5985",
        city: "Søby Ærø",
        url: "https://www.kunstaeroe.dk/",
      },
      occurrences: [{
        id: `course-${page.id.toLowerCase()}`,
        date: range.startDate,
        endDate: range.endDate,
        allDay: true,
        timeUnknown: false,
      }],
      status: "scheduled",
      availability: soldOut ? "sold-out" : "available",
      attendance: "registration",
      attendanceDetails: soldOut ? "Kurset er markeret som udsolgt." : "Tilmelding kræves.",
      ...(priceLine ? { price: priceLine } : {}),
      ...(bookingUrl ? { bookingUrl } : {}),
      bookingRequired: true,
      ...(soldOut ? { bookingDetails: "Udsolgt; se kursussiden for eventuel ændring eller venteliste." } : {}),
      publication: reviewReasons.length === 0 ? "trusted" : "review",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: page.id,
        sourceUrl: canonicalSourceUrl,
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
    const listingHtml = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    pagesFetched += 1;
    const listing = parseKunsthoejskolenListing(listingHtml, definition.url, context.now);
    warnings.push(...listing.warnings);
    errors.push(...listing.errors);
    for (const item of listing.items) {
      if (errors.length > 0) break;
      const detailHtml = await fetchText(context, item.url, { expectedOrigin: SOURCE_ORIGIN });
      pagesFetched += 1;
      const parsed = parseKunsthoejskolenDetail(detailHtml, item.url, item, retrievedAt);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors.map((error) => `${item.title}: ${error}`));
      if (parsed.candidate) candidates.push(parsed.candidate);
    }
    if (errors.length > 0) {
      return {
        status: "partial", source: definition, retrievedAt, pagesFetched,
        candidates: [], errors: [...new Set(errors)], warnings: [...new Set(warnings)],
        discardedCandidateCount: candidates.length,
      };
    }
    return {
      status: "complete", source: definition, retrievedAt, pagesFetched,
      candidates, errors: [], warnings: [...new Set(warnings)],
    };
  } catch (error) {
    return {
      status: pagesFetched > 0 ? "partial" : "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [...new Set(warnings)],
      ...(pagesFetched > 0 ? { discardedCandidateCount: candidates.length } : {}),
    } as CollectionResult;
  }
}

export const kunsthoejskolenSource: SourceAdapter = { definition, collect };
