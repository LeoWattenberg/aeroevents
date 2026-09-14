import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-kirkeliv"];
const COPENHAGEN = "Europe/Copenhagen";
const MAX_PAGES = 100;
const CHURCHDESK_ORIGIN = new URL(definition.url).origin;

interface ChurchDeskItem {
  id?: unknown;
  title?: unknown;
  cancelledAt?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  description?: unknown;
  summary?: unknown;
  hideEndTime?: unknown;
  allDay?: unknown;
  price?: unknown;
  url?: unknown;
  location?: unknown;
  locationName?: unknown;
  locationObj?: {
    address?: unknown;
    city?: unknown;
    zipcode?: unknown;
  };
}

interface ChurchDeskWidgetPayload {
  items: ChurchDeskItem[];
  pageNumber: number;
  total: number;
  totalPages: number;
  pageSize: number;
}

export interface ChurchDeskPageResult {
  payload?: ChurchDeskWidgetPayload;
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

function requiredInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function descriptionText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const $ = load(`<main>${value}</main>`);
  $("br").replaceWith("\n");
  const text = $("main")
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function parseInstant(
  value: unknown,
  allDay: boolean,
): { date: string; time?: string } | undefined {
  if (typeof value !== "string") return undefined;
  if (allDay) {
    const date = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    return date ? { date } : undefined;
  }
  const parsed = DateTime.fromISO(value, { setZone: true }).setZone(COPENHAGEN);
  if (!parsed.isValid) return undefined;
  return { date: parsed.toISODate()!, time: parsed.toFormat("HH:mm") };
}

function parseLocation(item: ChurchDeskItem): EventLocationDraft | undefined {
  const location: EventLocationDraft = {};
  const name = optionalString(item.locationName);
  const address = optionalString(item.locationObj?.address);
  const postalCode = optionalString(item.locationObj?.zipcode);
  const city = optionalString(item.locationObj?.city);
  const fallbackAddress = optionalString(item.location);
  const resolvedAddress = address ?? fallbackAddress;
  if (name) location.name = name;
  if (resolvedAddress) location.address = resolvedAddress;
  if (postalCode) location.postalCode = postalCode;
  if (city) location.city = city;
  return Object.keys(location).length > 0 ? location : undefined;
}

function normalizeItem(
  item: ChurchDeskItem,
  retrievedAt: string,
  itemIndex: number,
): { candidate?: NormalizedEventDraft; errors: string[] } {
  const errors: string[] = [];
  const id =
    typeof item.id === "string" || typeof item.id === "number"
      ? String(item.id)
      : undefined;
  const title = optionalString(item.title);
  const allDay = item.allDay === true;
  const start = parseInstant(item.startDate, allDay);
  const end = parseInstant(item.endDate, allDay);

  if (!id) errors.push(`Element ${itemIndex + 1} mangler et ChurchDesk-id`);
  if (!title) errors.push(`ChurchDesk-element ${id ?? itemIndex + 1} mangler titel`);
  if (!start) errors.push(`ChurchDesk-element ${id ?? itemIndex + 1} mangler gyldig startdato`);
  if (errors.length > 0 || !id || !title || !start) return { errors };

  const sourceUrl =
    optionalString(item.url) ??
    `https://www.xn--rkirkeliv-f3a3r.dk/b/${encodeURIComponent(id)}`;
  const hideEndTime = item.hideEndTime === true;
  const occurrence = {
    id: `churchdesk-${id}`,
    date: start.date,
    ...(start.time ? { startTime: start.time } : {}),
    ...(end ? { endDate: end.date } : {}),
    ...(!hideEndTime && end?.time ? { endTime: end.time } : {}),
    allDay,
    timeUnknown: !allDay && start.time === undefined,
  };
  const description = descriptionText(item.description) ?? descriptionText(item.summary);
  const location = parseLocation(item);
  const price = optionalString(item.price) ??
    (typeof item.price === "number" ? String(item.price) : undefined);

  return {
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId: id,
      stableId: `${definition.id}-${id}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(location ? { location } : {}),
      occurrences: [occurrence],
      status: item.cancelledAt ? "cancelled" : "scheduled",
      attendance: "public",
      ...(price ? { price } : {}),
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: id,
        sourceUrl,
        retrievedAt,
      },
    },
  };
}

export function parseChurchDeskPage(
  html: string,
  retrievedAt: string,
): ChurchDeskPageResult {
  const $ = load(html);
  const raw = $("#__NEXT_DATA__").first().html();
  if (!raw) {
    return {
      candidates: [],
      warnings: [],
      errors: ["ChurchDesk-siden mangler __NEXT_DATA__"],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      candidates: [],
      warnings: [],
      errors: ["ChurchDesk-sidens __NEXT_DATA__ er ugyldig JSON"],
    };
  }

  const pageProps = (data as { props?: { pageProps?: unknown } })?.props?.pageProps;
  const widget = (pageProps as { widget?: unknown })?.widget as
    | Record<string, unknown>
    | undefined;
  const items = widget?.items;
  const pageNumber = requiredInteger(widget?.pageNumber);
  const total = requiredInteger(widget?.total);
  const totalPages = requiredInteger(widget?.totalPages);
  const pageSize = requiredInteger(widget?.pageSize);
  const structuralErrors: string[] = [];
  if (!Array.isArray(items)) structuralErrors.push("ChurchDesk-data mangler items-listen");
  if (pageNumber === undefined || pageNumber < 1)
    structuralErrors.push("ChurchDesk-data mangler et gyldigt sidetal");
  if (total === undefined) structuralErrors.push("ChurchDesk-data mangler total");
  if (totalPages === undefined || totalPages < 1 || totalPages > MAX_PAGES)
    structuralErrors.push("ChurchDesk-data har et ugyldigt antal sider");
  if (pageSize === undefined || pageSize < 1)
    structuralErrors.push("ChurchDesk-data mangler en gyldig sidestørrelse");
  if (
    structuralErrors.length > 0 ||
    !Array.isArray(items) ||
    pageNumber === undefined ||
    total === undefined ||
    totalPages === undefined ||
    pageSize === undefined
  ) {
    return { candidates: [], warnings: [], errors: structuralErrors };
  }

  const candidates: NormalizedEventDraft[] = [];
  const errors: string[] = [];
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      errors.push(`ChurchDesk-element ${index + 1} er ikke et objekt`);
      return;
    }
    const normalized = normalizeItem(item as ChurchDeskItem, retrievedAt, index);
    errors.push(...normalized.errors);
    if (normalized.candidate) candidates.push(normalized.candidate);
  });

  return {
    payload: { items, pageNumber, total, totalPages, pageSize },
    candidates,
    warnings: [],
    errors,
  };
}

export function churchDeskPageUrl(pageNumber: number): string {
  return `https://widget.churchdesk.com/da/w/1709/event/7HsDjgjjLaLL/${pageNumber}/1350954`;
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const collected: NormalizedEventDraft[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let pagesFetched = 0;
  let expectedTotal: number | undefined;
  let totalPages: number | undefined;

  try {
    for (let page = 1; page <= (totalPages ?? 1); page += 1) {
      const html = await fetchText(context, churchDeskPageUrl(page), {
        expectedOrigin: CHURCHDESK_ORIGIN,
      });
      pagesFetched += 1;
      const parsed = parseChurchDeskPage(html, retrievedAt);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors);
      if (!parsed.payload) break;

      if (parsed.payload.pageNumber !== page) {
        errors.push(
          `ChurchDesk returnerede side ${parsed.payload.pageNumber}, forventede side ${page}`,
        );
        break;
      }
      if (page === 1) {
        expectedTotal = parsed.payload.total;
        totalPages = parsed.payload.totalPages;
        if (expectedTotal === 0 || parsed.candidates.length === 0) {
          errors.push("ChurchDesk returnerede ingen begivenheder; snapshot beholdes");
          break;
        }
      } else if (
        parsed.payload.total !== expectedTotal ||
        parsed.payload.totalPages !== totalPages
      ) {
        errors.push("ChurchDesk-pagination ændrede sig under indsamlingen");
        break;
      }
      collected.push(...parsed.candidates);
      if (parsed.errors.length > 0) break;
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
        errors: [message],
        warnings,
      };
    }
    errors.push(message);
  }

  const ids = collected.map((candidate) => candidate.sourceEventId);
  if (new Set(ids).size !== ids.length) {
    errors.push("ChurchDesk returnerede samme begivenheds-id flere gange");
  }
  if (expectedTotal !== undefined && collected.length !== expectedTotal) {
    errors.push(
      `ChurchDesk oplyste ${expectedTotal} begivenheder, men ${collected.length} blev aflæst`,
    );
  }

  if (errors.length > 0) {
    return {
      status: "partial",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [...new Set(errors)],
      warnings,
      discardedCandidateCount: collected.length,
    };
  }

  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates: collected,
    errors: [],
    warnings,
  };
}

export const churchDeskSource: SourceAdapter = { definition, collect };
