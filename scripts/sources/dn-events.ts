import { DateTime } from "luxon";

import { errorMessage, fetchJson } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["dn-aeroe"];
const COPENHAGEN = "Europe/Copenhagen";
const DN_API_ORIGIN = "https://func-dn-events-production-003.azurewebsites.net";
const DN_API_BASE = `${DN_API_ORIGIN}/api`;
const DN_PUBLIC_BASE = "https://arrangementer.dn.dk/arrangementer/";
const MUNICIPALITY_CODE = "0492";
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

interface DnSearchPage {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  itemIds: string[];
}

export interface DnSearchParseResult {
  page?: DnSearchPage;
  warnings: string[];
  errors: string[];
}

export interface DnEventParseResult {
  candidate?: NormalizedEventDraft;
  excluded: boolean;
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

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function descriptionText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const result = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
  return result || undefined;
}

function eventId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function publicHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
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

function instant(value: unknown): DateTime | undefined {
  if (typeof value !== "string" || !/(?:z|[+-]\d{2}:?\d{2})$/iu.test(value)) {
    return undefined;
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed : undefined;
}

function addressLine(address: Record<string, unknown>): string | undefined {
  const street = nonEmptyText(address.streetName);
  const houseNumber = nonEmptyText(address.houseNumber);
  const floor = nonEmptyText(address.floor);
  const letter = nonEmptyText(address.letter);
  const door = nonEmptyText(address.door);
  if (!street) return undefined;
  return cleanText(
    [street, houseNumber, letter, floor ? `${floor}.` : undefined, door]
      .filter(Boolean)
      .join(" "),
  );
}

function priceFromText(description: string | undefined, explicit: unknown): string | undefined {
  const supplied =
    typeof explicit === "number" && Number.isFinite(explicit)
      ? `${explicit} kr.`
      : nonEmptyText(explicit);
  if (supplied) return supplied;
  if (!description) return undefined;
  if (/\bgratis\b/iu.test(description)) return "Gratis";
  const match = description.match(
    /\b(?:pris(?:en)?(?:\s+er)?|koster|egenbetaling(?:en)?(?:\s+er)?|for\s+(?:kun\s+)?)[\s:]*(\d+(?:[.,]\d{1,2})?)\s*kr\b/iu,
  );
  return match?.[1] ? `${match[1]} kr.` : undefined;
}

function signupDetails(item: Record<string, unknown>): string | undefined {
  const values = [item.signupInfo, item.signupTypeData]
    .map(descriptionText)
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(values)].join("\n");
  return unique ? unique.slice(0, 500) : undefined;
}

export function dnSearchPageUrl(pageIndex: number, pageSize = PAGE_SIZE): string {
  const url = new URL(`${DN_API_BASE}/events/search`);
  url.searchParams.set("municipalityCodes", MUNICIPALITY_CODE);
  url.searchParams.set("pageIndex", String(pageIndex));
  url.searchParams.set("pageSize", String(pageSize));
  return url.toString();
}

export function dnDetailUrl(id: string): string {
  return `${DN_API_BASE}/events/${encodeURIComponent(id)}`;
}

export function parseDnSearchPage(
  value: unknown,
  expectedPage?: number,
): DnSearchParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const data = record(value);
  if (!data) return { warnings, errors: ["DN-søgesvaret er ikke et objekt"] };

  const currentPage = integer(data.currentPage);
  const totalPages = integer(data.totalPages);
  const totalItems = integer(data.totalItems);
  const itemsPerPage = integer(data.itemsPerPage);
  const items = Array.isArray(data.items) ? data.items : undefined;
  if (currentPage === undefined || currentPage < 0) errors.push("DN-søgesvaret mangler currentPage");
  if (totalPages === undefined || totalPages < 0 || totalPages > MAX_PAGES) {
    errors.push("DN-søgesvaret har et ugyldigt totalPages");
  }
  if (totalItems === undefined || totalItems < 0) errors.push("DN-søgesvaret mangler totalItems");
  if (itemsPerPage === undefined || itemsPerPage < 1 || itemsPerPage > 200) {
    errors.push("DN-søgesvaret har et ugyldigt itemsPerPage");
  }
  if (!items) errors.push("DN-søgesvaret mangler items-listen");
  if (expectedPage !== undefined && currentPage !== undefined && currentPage !== expectedPage) {
    errors.push(`DN returnerede side ${currentPage}, forventede side ${expectedPage}`);
  }
  if (
    currentPage === undefined ||
    totalPages === undefined ||
    totalItems === undefined ||
    itemsPerPage === undefined ||
    !items ||
    errors.length > 0
  ) {
    return { warnings, errors };
  }

  const itemIds: string[] = [];
  items.forEach((item, index) => {
    const id = eventId(record(item)?.id);
    if (!id) errors.push(`DN-søgeresultat ${index + 1} mangler et stabilt numerisk id`);
    else itemIds.push(id);
  });
  if (new Set(itemIds).size !== itemIds.length) {
    errors.push("DN-søgesiden indeholder samme event-id flere gange");
  }
  if (items.length > itemsPerPage) {
    errors.push("DN-søgesiden indeholder flere poster end itemsPerPage");
  }
  if (totalItems === 0 && (totalPages !== 0 || items.length !== 0)) {
    errors.push("DN-søgesvarets tomme pagination er inkonsistent");
  }
  if (totalItems > 0 && totalPages < 1) {
    errors.push("DN-søgesvaret har poster, men ingen sider");
  }
  if (data.hasNextPage === true && currentPage + 1 >= totalPages) {
    // The API currently reports true on its last non-empty page. Do not follow
    // that flag, but retain a diagnostic if its documented totals disagree.
    warnings.push("DN markerede sidste side med hasNextPage; totalPages blev anvendt");
  }

  return {
    ...(errors.length === 0
      ? { page: { currentPage, totalPages, totalItems, itemsPerPage, itemIds } }
      : {}),
    warnings,
    errors,
  };
}

export function parseDnEvent(value: unknown, retrievedAt: string): DnEventParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const item = record(value);
  if (!item) return { excluded: false, warnings, errors: ["DN-detaljen er ikke et objekt"] };

  const id = eventId(item.id);
  const title = nonEmptyText(item.title);
  const start = instant(item.start);
  const end = instant(item.end);
  const cancelledAt =
    item.cancelledAt === null || item.cancelledAt === undefined || item.cancelledAt === ""
      ? undefined
      : instant(item.cancelledAt);
  const address = record(item.address);
  const municipalityCode = nonEmptyText(address?.municipalityCode ?? address?.municipality);
  if (!id) errors.push("DN-detaljen mangler et stabilt numerisk id");
  if (!title) errors.push(`DN-arrangement ${id ?? "ukendt"} mangler titel`);
  if (!start) errors.push(`DN-arrangement ${id ?? "ukendt"} mangler starttid med offset`);
  if (!end) errors.push(`DN-arrangement ${id ?? "ukendt"} mangler sluttid med offset`);
  if (start && end && end <= start) {
    errors.push(`DN-arrangement ${id ?? "ukendt"} har sluttid før eller lig starttid`);
  }
  if (typeof item.private !== "boolean") {
    errors.push(`DN-arrangement ${id ?? "ukendt"} mangler offentlig/privat-markering`);
  }
  if (typeof item.occupied !== "boolean") {
    errors.push(`DN-arrangement ${id ?? "ukendt"} mangler kapacitetsstatus`);
  }
  if (typeof item.hideAddress !== "boolean") {
    errors.push(`DN-arrangement ${id ?? "ukendt"} mangler adressevisningsstatus`);
  }
  if (
    item.cancelledAt !== null &&
    item.cancelledAt !== undefined &&
    item.cancelledAt !== "" &&
    !cancelledAt
  ) {
    errors.push(`DN-arrangement ${id ?? "ukendt"} har et ugyldigt aflysningstidspunkt`);
  }
  if (!address || municipalityCode !== MUNICIPALITY_CODE) {
    errors.push(`DN-arrangement ${id ?? "ukendt"} er ikke sikkert stedfæstet i Ærø Kommune`);
  }
  if (errors.length > 0 || !id || !title || !start || !end || !address) {
    return { excluded: false, warnings, errors };
  }
  if (item.private === true) {
    return {
      excluded: true,
      warnings: [`DN-arrangement ${id} er privat og blev udeladt`],
      errors,
    };
  }

  const sourceUrl = `${DN_PUBLIC_BASE}${id}`;
  const description = descriptionText(item.description) ?? descriptionText(item.teaser);
  const hiddenAddress = item.hideAddress === true;
  const location: EventLocationDraft = {};
  const locationName = nonEmptyText(item.locationDirections);
  if (locationName) location.name = locationName;
  if (!hiddenAddress) {
    const street = addressLine(address);
    const postalCode = nonEmptyText(address.postalCode);
    const city = nonEmptyText(address.city);
    if (street) location.address = street;
    if (postalCode) location.postalCode = postalCode;
    if (city) location.city = city;
  }
  if (!location.name && location.address) location.name = location.address;

  const signupType = nonEmptyText(item.signupType)?.toLocaleLowerCase("da-DK");
  const signup = signupDetails(item);
  const bookingRequired = Boolean(
    item.useSignupInfo === true ||
      /\btilmelding(?:en)?\s+(?:er\s+)?(?:nødvendig|påkrævet|kræves)\b/iu.test(
        `${description ?? ""}\n${signup ?? ""}`,
      ),
  );
  const signupUrl =
    signupType && /^(?:link|url|website|web)$/.test(signupType)
      ? publicHttpUrl(item.signupTypeData)
      : undefined;
  const suppliedUrl = publicHttpUrl(item.url);
  const bookingUrl = signupUrl ?? suppliedUrl;
  const modified = instant(item.updated);
  if (item.updated && !modified) {
    warnings.push(`DN-arrangement ${id} har et ugyldigt ændringstidspunkt`);
  }
  const startLocal = start.setZone(COPENHAGEN);
  const endLocal = end.setZone(COPENHAGEN);
  const cancelled = Boolean(cancelledAt);
  const price = priceFromText(description, item.price);

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
      categoryIds: [...definition.categoryIds],
      ...(location.name ? { location } : {}),
      occurrences: [
        {
          id: `dn-${id}`,
          date: startLocal.toISODate()!,
          startTime: startLocal.toFormat("HH:mm"),
          ...(endLocal.toISODate() !== startLocal.toISODate()
            ? { endDate: endLocal.toISODate()! }
            : {}),
          endTime: endLocal.toFormat("HH:mm"),
          allDay: false,
          timeUnknown: false,
        },
      ],
      status: cancelled ? "cancelled" : "scheduled",
      ...(item.occupied === true ? { availability: "sold-out" } : {}),
      attendance: bookingRequired ? "registration" : "public",
      ...(bookingRequired ? { attendanceDetails: "Tilmelding er påkrævet." } : {}),
      ...(price ? { price } : {}),
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(signup ? { bookingDetails: signup } : {}),
      ...(signup || bookingRequired ? { bookingRequired } : {}),
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: id,
        sourceUrl,
        retrievedAt,
        ...(modified ? { sourceModifiedAt: modified.toUTC().toISO()! } : {}),
      },
    },
  };
}

export async function collectDnEvents(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const ids: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  let pagesFetched = 0;
  let expectedTotalPages: number | undefined;
  let expectedTotalItems: number | undefined;

  try {
    for (let pageIndex = 0; pageIndex < (expectedTotalPages ?? 1); pageIndex += 1) {
      const value = await fetchJson(context, dnSearchPageUrl(pageIndex), {
        expectedOrigin: DN_API_ORIGIN,
      });
      pagesFetched += 1;
      const parsed = parseDnSearchPage(value, pageIndex);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors);
      if (!parsed.page) break;
      if (pageIndex === 0) {
        expectedTotalPages = parsed.page.totalPages;
        expectedTotalItems = parsed.page.totalItems;
        if (expectedTotalItems === 0 || expectedTotalPages === 0) {
          errors.push("DN returnerede ingen Ærø-arrangementer; snapshot beholdes");
          break;
        }
      } else if (
        parsed.page.totalPages !== expectedTotalPages ||
        parsed.page.totalItems !== expectedTotalItems
      ) {
        errors.push("DN-pagination ændrede sig under indsamlingen");
        break;
      }
      ids.push(...parsed.page.itemIds);
      if (parsed.page.itemIds.length === 0 && ids.length < (expectedTotalItems ?? 0)) {
        errors.push("DN returnerede en tom side før alle arrangementer var hentet");
        break;
      }
    }

    if (new Set(ids).size !== ids.length) {
      errors.push("DN returnerede samme event-id på flere sider");
    }
    if (expectedTotalItems !== undefined && ids.length !== expectedTotalItems) {
      errors.push(`DN oplyste ${expectedTotalItems} arrangementer, men ${ids.length} id'er blev hentet`);
    }

    if (errors.length === 0) {
      for (const id of ids) {
        const value = await fetchJson(context, dnDetailUrl(id), {
          expectedOrigin: DN_API_ORIGIN,
        });
        pagesFetched += 1;
        const parsed = parseDnEvent(value, retrievedAt);
        warnings.push(...parsed.warnings);
        errors.push(...parsed.errors);
        if (parsed.candidate) {
          if (parsed.candidate.sourceEventId !== id) {
            errors.push(`DN-detaljen for ${id} returnerede id ${parsed.candidate.sourceEventId}`);
            break;
          }
          candidates.push(parsed.candidate);
        }
        if (parsed.errors.length > 0) break;
      }
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

  if (candidates.length === 0 && errors.length === 0) {
    errors.push("DN gav ingen offentlige Ærø-arrangementer; snapshot beholdes");
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

export const dnEventsSource: SourceAdapter = { definition, collect: collectDnEvents };
