import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchJson, sameOriginHttpsUrl } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["campus-aeroe"];
const COPENHAGEN = "Europe/Copenhagen";
const CAMPUS_ORIGIN = new URL(definition.url).origin;
const CAMPUS_API = `${CAMPUS_ORIGIN}/wp-json/tribe/events/v1/events`;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

/** Categories observed to contain public-facing activities. Every item still goes to review. */
export const CAMPUS_ALLOWED_CATEGORY_SLUGS = new Set([
  "campus-ugentlig",
  "foredrag",
  "kultur",
  "sundhedsfestival",
]);

interface CampusPage {
  total: number;
  totalPages: number;
  itemCount: number;
  eventIds: string[];
  candidates: NormalizedEventDraft[];
  excludedCount: number;
}

export interface CampusPageParseResult {
  page?: CampusPage;
  warnings: string[];
  errors: string[];
}

export interface CampusEventParseResult {
  candidate?: NormalizedEventDraft;
  excluded: boolean;
  excludedReason?: string;
  warnings: string[];
  errors: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function eventId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function htmlText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const $ = load(`<main>${value}</main>`);
  $("br").replaceWith("\n");
  $("p, li, h1, h2, h3, h4").each((_index, element) => {
    $(element).append("\n");
  });
  const result = $("main")
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
  return result || undefined;
}

function plainText(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function localDateTime(value: unknown): DateTime | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return undefined;
  }
  const parsed = DateTime.fromFormat(value, "yyyy-MM-dd HH:mm:ss", { zone: COPENHAGEN });
  return parsed.isValid ? parsed : undefined;
}

function modifiedInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.fromFormat(value, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
  return parsed.isValid ? parsed.toISO()! : undefined;
}

function safePublicUrl(value: unknown, sameOrigin = false): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    if (sameOrigin) return sameOriginHttpsUrl(value, CAMPUS_ORIGIN);
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function categorySlugs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slugs: string[] = [];
  for (const category of value) {
    const slug = plainText(record(category)?.slug)?.toLocaleLowerCase("da-DK");
    if (!slug) return undefined;
    slugs.push(slug);
  }
  return [...new Set(slugs)];
}

function mappedCategoryIds(slugs: string[], text: string): string[] {
  const categories = new Set<string>();
  if (slugs.includes("kultur") || slugs.includes("foredrag") || /\b(?:kunst|musik|koncert|foredrag)\b/iu.test(text)) {
    categories.add("musik-kultur");
  }
  if (/\b(?:idræt|motion|sport|yoga)\b/iu.test(text)) categories.add("sport-motion");
  if (/\b(?:børn|unge|familie|klasse)\b/iu.test(text)) categories.add("boern-familie");
  if (slugs.includes("campus-ugentlig") && categories.size === 0) {
    categories.add("forening-faellesskab");
  }
  if (categories.size === 0) definition.categoryIds.forEach((id) => categories.add(id));
  return [...categories];
}

function restrictedAudienceReason(text: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bkun\s+for\b/iu, "teksten siger, at arrangementet kun er for en afgrænset gruppe"],
    [/\breserveret\s+til\b/iu, "stedet er reserveret til en afgrænset gruppe"],
    [/\bfor\s+fagfolk\b/iu, "arrangementet er rettet mod fagfolk"],
    [/\b(?:personale|medarbejdere)s?(?:kursus|undervisning)?\b/iu, "arrangementet er internt for personale"],
    [/\belevernes\s+(?:virtuelle\s+)?undervisning\b/iu, "arrangementet er undervisning for elever"],
  ];
  return patterns.find(([pattern]) => pattern.test(text))?.[1];
}

function parseVenue(value: unknown): { location?: EventLocationDraft; error?: string } {
  if (Array.isArray(value)) {
    return value.length === 0
      ? {}
      : { error: "Campus-arrangementets venue har et ukendt listeformat" };
  }
  if (value === undefined || value === null || value === false) return {};
  const venue = record(value);
  if (!venue) return { error: "Campus-arrangementets venue er ugyldigt" };
  const name = htmlText(venue.venue);
  if (!name) return { error: "Campus-arrangementets venue mangler navn" };
  const location: EventLocationDraft = { name };
  const address = htmlText(venue.address);
  const postalCode = plainText(venue.zip);
  const city = htmlText(venue.city);
  const url = venue.url === undefined || venue.url === "" ? undefined : safePublicUrl(venue.url, true);
  if (venue.url && !url) return { error: "Campus-arrangementets venue-link er usikkert" };
  if (address) location.address = address;
  if (postalCode) location.postalCode = postalCode;
  if (city) location.city = city;
  if (url) location.url = url;
  return { location };
}

function bookingLink(descriptionHtml: unknown, website: unknown): { url?: string; error?: string } {
  if (typeof website === "string" && website.trim()) {
    const url = safePublicUrl(website);
    return url ? { url } : { error: "Campus-arrangementets website-link er usikkert" };
  }
  if (typeof descriptionHtml !== "string") return {};
  const $ = load(`<main>${descriptionHtml}</main>`);
  const matching = $("main a[href]").filter((_index, element) =>
    /\b(?:tilmeld|bestil|billet|booking)\b/iu.test(cleanText($(element).text())),
  );
  const href = matching.first().attr("href");
  if (!href) return {};
  const url = safePublicUrl(href);
  return url ? { url } : { error: "Campus-arrangementets tilmeldingslink er usikkert" };
}

function price(item: Record<string, unknown>, text: string): string | undefined {
  const explicit = htmlText(item.cost);
  if (explicit) return explicit;
  return /\bgratis\b/iu.test(text) ? "Gratis" : undefined;
}

function status(item: Record<string, unknown>, title: string): "scheduled" | "cancelled" | "postponed" {
  const sourceStatus = plainText(item.event_status)?.toLocaleLowerCase("da-DK") ?? "";
  if (/^(?:cancelled|canceled|aflyst)$/.test(sourceStatus) || /^aflyst\b/iu.test(title)) {
    return "cancelled";
  }
  if (/^(?:postponed|udsat)$/.test(sourceStatus) || /^(?:udsat|flyttet)\b/iu.test(title)) {
    return "postponed";
  }
  return "scheduled";
}

export function campusPageUrl(page: number, now: Date, perPage = PAGE_SIZE): string {
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(COPENHAGEN).startOf("day");
  const url = new URL(CAMPUS_API);
  url.searchParams.set("start_date", today.toISODate()!);
  url.searchParams.set("end_date", today.plus({ months: 12 }).toISODate()!);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("status", "publish");
  return url.toString();
}

export function parseCampusEvent(value: unknown, retrievedAt: string): CampusEventParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const item = record(value);
  if (!item) return { excluded: false, warnings, errors: ["Campus-posten er ikke et objekt"] };

  const id = eventId(item.id);
  const title = htmlText(item.title);
  const description = htmlText(item.description) ?? htmlText(item.excerpt);
  const sourceUrl = safePublicUrl(item.url, true);
  const publicationStatus = plainText(item.status);
  const timezone = plainText(item.timezone);
  const start = localDateTime(item.start_date);
  const end = localDateTime(item.end_date);
  const slugs = categorySlugs(item.categories);
  const allDay = item.all_day;
  if (!id) errors.push("Campus-posten mangler et stabilt numerisk id");
  if (!title) errors.push(`Campus-post ${id ?? "ukendt"} mangler titel`);
  if (!sourceUrl) errors.push(`Campus-post ${id ?? "ukendt"} mangler et sikkert kanonisk link`);
  if (publicationStatus !== "publish") {
    errors.push(`Campus-post ${id ?? "ukendt"} er ikke markeret som publiceret`);
  }
  if (timezone !== COPENHAGEN) {
    errors.push(`Campus-post ${id ?? "ukendt"} bruger en uventet tidszone`);
  }
  if (!start) errors.push(`Campus-post ${id ?? "ukendt"} mangler gyldig startdato`);
  if (!end) errors.push(`Campus-post ${id ?? "ukendt"} mangler gyldig slutdato`);
  if (start && end && end < start) errors.push(`Campus-post ${id ?? "ukendt"} slutter før den starter`);
  if (typeof allDay !== "boolean") errors.push(`Campus-post ${id ?? "ukendt"} mangler all_day`);
  if (typeof item.hide_from_listings !== "boolean") {
    errors.push(`Campus-post ${id ?? "ukendt"} mangler hide_from_listings`);
  }
  if (!slugs) errors.push(`Campus-post ${id ?? "ukendt"} har ugyldige kategorier`);
  const venue = parseVenue(item.venue);
  if (venue.error) errors.push(`${venue.error} (${id ?? "ukendt"})`);
  const booking = bookingLink(item.description, item.website);
  if (booking.error) errors.push(`${booking.error} (${id ?? "ukendt"})`);
  if (
    errors.length > 0 ||
    !id ||
    !title ||
    !sourceUrl ||
    !start ||
    !end ||
    typeof allDay !== "boolean" ||
    !slugs
  ) {
    return { excluded: false, warnings, errors };
  }

  const combinedText = `${title}\n${description ?? ""}`;
  const allowed = slugs.some((slug) => CAMPUS_ALLOWED_CATEGORY_SLUGS.has(slug));
  const restricted =
    item.hide_from_listings === true
      ? "posten er skjult fra den offentlige arrangementsliste"
      : restrictedAudienceReason(combinedText);
  if (!allowed || restricted) {
    return {
      excluded: true,
      excludedReason: restricted ?? "kategorien er ikke på allowlisten for offentlige arrangementer",
      warnings,
      errors,
    };
  }

  const bookingRequired = /\b(?:kræver|kræves|nødvendig|påkrævet)\s+tilmelding\b|\btilmelding(?:en)?\s+(?:er\s+)?(?:nødvendig|påkrævet|kræves)\b/iu.test(
    combinedText,
  );
  const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/iu.test(combinedText);
  const eventStatus = status(item, title);
  const sourceModifiedAt = modifiedInstant(item.modified_utc);
  if (item.modified_utc && !sourceModifiedAt) {
    warnings.push(`Campus-post ${id} har et ugyldigt ændringstidspunkt`);
  }
  const occurrence = allDay
    ? {
        id: `campus-${id}`,
        date: start.toISODate()!,
        ...(end.toISODate() !== start.toISODate() ? { endDate: end.toISODate()! } : {}),
        allDay: true,
        timeUnknown: false,
      }
    : {
        id: `campus-${id}`,
        date: start.toISODate()!,
        startTime: start.toFormat("HH:mm"),
        ...(end.toISODate() !== start.toISODate() ? { endDate: end.toISODate()! } : {}),
        endTime: end.toFormat("HH:mm"),
        allDay: false,
        timeUnknown: false,
      };

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
      categoryIds: mappedCategoryIds(slugs, combinedText),
      ...(venue.location ? { location: venue.location } : {}),
      occurrences: [occurrence],
      status: eventStatus,
      ...(soldOut ? { availability: "sold-out" } : {}),
      attendance: bookingRequired ? "registration" : "public",
      ...(bookingRequired ? { attendanceDetails: "Tilmelding er påkrævet." } : {}),
      ...(price(item, combinedText) ? { price: price(item, combinedText)! } : {}),
      ...(booking.url ? { bookingUrl: booking.url } : {}),
      ...(booking.url || bookingRequired ? { bookingRequired } : {}),
      publication: "review",
      reviewReasons: [
        "Campus-kalenderen blander offentlige arrangementer med undervisning og interne forløb",
      ],
      provenance: {
        sourceId: definition.id,
        externalId: id,
        sourceUrl,
        retrievedAt,
        ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
      },
    },
  };
}

export function parseCampusPage(
  value: unknown,
  retrievedAt: string,
  expectedPage?: number,
): CampusPageParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const data = record(value);
  if (!data) return { warnings, errors: ["Campus API-svaret er ikke et objekt"] };
  const total = integer(data.total);
  const totalPages = integer(data.total_pages);
  const events = Array.isArray(data.events) ? data.events : undefined;
  if (total === undefined || total < 0) errors.push("Campus API-svaret mangler total");
  if (totalPages === undefined || totalPages < 0 || totalPages > MAX_PAGES) {
    errors.push("Campus API-svaret har et ugyldigt total_pages");
  }
  if (!events) errors.push("Campus API-svaret mangler events-listen");
  if (total === 0 && (totalPages !== 0 || events?.length !== 0)) {
    errors.push("Campus API-svarets tomme pagination er inkonsistent");
  }
  if (total !== undefined && total > 0 && totalPages !== undefined && totalPages < 1) {
    errors.push("Campus API-svaret har events, men ingen sider");
  }
  if (data.next_rest_url !== undefined && data.next_rest_url !== null && data.next_rest_url !== "") {
    try {
      const next = new URL(sameOriginHttpsUrl(String(data.next_rest_url), CAMPUS_ORIGIN));
      if (expectedPage !== undefined && next.searchParams.get("page") !== String(expectedPage + 1)) {
        errors.push("Campus API-svarets næste-side-link har et uventet sidetal");
      }
    } catch (error) {
      errors.push(`Campus API-svarets næste-side-link er usikkert: ${errorMessage(error)}`);
    }
  }
  if (total === undefined || totalPages === undefined || !events || errors.length > 0) {
    return { warnings, errors };
  }

  const eventIds: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  let excludedCount = 0;
  for (const event of events) {
    const parsed = parseCampusEvent(event, retrievedAt);
    warnings.push(...parsed.warnings);
    errors.push(...parsed.errors);
    const id = eventId(record(event)?.id);
    if (id) eventIds.push(id);
    if (parsed.candidate) candidates.push(parsed.candidate);
    if (parsed.excluded) excludedCount += 1;
  }
  if (new Set(eventIds).size !== eventIds.length) {
    errors.push("Campus API-siden indeholder samme event-id flere gange");
  }
  if (excludedCount > 0) {
    warnings.push(
      `Campus: ${excludedCount} poster blev udeladt af målgruppe- og kategori-allowlisten`,
    );
  }

  return {
    ...(errors.length === 0
      ? {
          page: {
            total,
            totalPages,
            itemCount: events.length,
            eventIds,
            candidates,
            excludedCount,
          },
        }
      : {}),
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

export async function collectCampusEvents(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  const allEventIds: string[] = [];
  let pagesFetched = 0;
  let itemsSeen = 0;
  let expectedTotal: number | undefined;
  let expectedTotalPages: number | undefined;

  try {
    for (let pageNumber = 1; pageNumber <= (expectedTotalPages ?? 1); pageNumber += 1) {
      const value = await fetchJson(context, campusPageUrl(pageNumber, context.now), {
        expectedOrigin: CAMPUS_ORIGIN,
      });
      pagesFetched += 1;
      const parsed = parseCampusPage(value, retrievedAt, pageNumber);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors);
      if (!parsed.page) break;
      if (pageNumber === 1) {
        expectedTotal = parsed.page.total;
        expectedTotalPages = parsed.page.totalPages;
        if (expectedTotal === 0 || expectedTotalPages === 0) {
          errors.push("Campus returnerede ingen arrangementer; snapshot beholdes");
          break;
        }
      } else if (
        parsed.page.total !== expectedTotal ||
        parsed.page.totalPages !== expectedTotalPages
      ) {
        errors.push("Campus-pagination ændrede sig under indsamlingen");
        break;
      }
      if (parsed.page.itemCount === 0 && itemsSeen < (expectedTotal ?? 0)) {
        errors.push("Campus returnerede en tom side før alle poster var hentet");
        break;
      }
      itemsSeen += parsed.page.itemCount;
      allEventIds.push(...parsed.page.eventIds);
      candidates.push(...parsed.page.candidates);
    }
  } catch (error) {
    const message = errorMessage(error);
    if (pagesFetched === 0) {
      return {
        status: "failed",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        warnings: [...new Set(warnings)],
        errors: [message],
      };
    }
    errors.push(message);
  }

  if (new Set(allEventIds).size !== allEventIds.length) {
    errors.push("Campus returnerede samme event-id på flere sider");
  }
  if (expectedTotal !== undefined && itemsSeen !== expectedTotal) {
    errors.push(`Campus oplyste ${expectedTotal} poster, men ${itemsSeen} blev hentet`);
  }
  if (candidates.length === 0 && errors.length === 0) {
    errors.push("Campus gav ingen allowlistede offentlige kandidater; snapshot beholdes");
  }
  if (errors.length > 0) {
    return {
      status: "partial",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      warnings: [...new Set(warnings)],
      errors: [...new Set(errors)],
      discardedCandidateCount: candidates.length,
    };
  }
  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates,
    warnings: [...new Set(warnings)],
    errors: [],
  };
}

export const campusSource: SourceAdapter = { definition, collect: collectCampusEvents };
