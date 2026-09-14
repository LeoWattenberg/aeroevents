import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchJson, sameOriginHttpsUrl } from "./http";
import { cleanText, deduplicateBy, plainText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY.motorfabrikken;
const COPENHAGEN = "Europe/Copenhagen";
const API_ORIGIN = "https://checkoutapi.ticketbutler.io";
const API_BASE = `${API_ORIGIN}/api`;
const TENANT_ORIGIN = "https://motorfabrikkenmarstal.ticketbutler.io";
const TENANT_HEADERS = {
  "accept-language": "da",
  origin: TENANT_ORIGIN,
  referer: `${TENANT_ORIGIN}/`,
};
const MAX_EVENTS = 500;

interface JsonObject {
  [key: string]: unknown;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = cleanText(value);
  return result || undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseZonedDate(value: unknown): DateTime | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.setZone(COPENHAGEN) : undefined;
}

function descriptionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const $ = load(`<article>${value}</article>`);
  return plainText($, $("article")) || undefined;
}

export function validateMotorfabrikkenTenant(value: unknown): string[] {
  const tenant = object(value);
  const contact = object(tenant?.contact_details);
  const errors: string[] = [];
  if (tenant?.domain !== "motorfabrikkenmarstal.ticketbutler.io") {
    errors.push("Ticketbutler-svaret tilhører ikke Motorfabrikkens hostname");
  }
  if (!/motorfabrikken marstal/i.test(nonEmptyText(tenant?.name) || "")) {
    errors.push("Ticketbutler-svaret tilhører ikke Motorfabrikken Marstal");
  }
  if (contact?.postcode !== "5960" || !/^marstal$/i.test(nonEmptyText(contact?.city) || "")) {
    errors.push("Ticketbutler-tenantens adresse er ikke længere i Marstal");
  }
  return errors;
}

export interface TicketbutlerCalendarItem {
  id: number;
  date: string;
}

export function parseTicketbutlerCalendar(value: unknown): {
  items: TicketbutlerCalendarItem[];
  errors: string[];
} {
  if (!Array.isArray(value)) {
    return { items: [], errors: ["Ticketbutlers månedskalender er ikke en liste"] };
  }
  const items: TicketbutlerCalendarItem[] = [];
  const errors: string[] = [];
  value.forEach((entryValue, index) => {
    const entry = object(entryValue);
    const id = safeInteger(entry?.pk);
    const dateTime = parseZonedDate(entry?.start_date);
    if (id === undefined || !dateTime) {
      errors.push(`Ticketbutlers kalenderpost ${index + 1} mangler id eller starttid`);
      return;
    }
    if (entry?.is_deleted === true) return;
    items.push({ id, date: dateTime.toISODate()! });
  });
  return { items: deduplicateBy(items, (item) => String(item.id)), errors };
}

export interface TicketbutlerListItem {
  id: number;
  slug: string;
  date: string;
  price?: string;
}

function formatPriceRange(value: unknown): string | undefined {
  const range = object(value);
  const minimum = typeof range?.min === "number" && Number.isFinite(range.min) ? range.min : undefined;
  const maximum = typeof range?.max === "number" && Number.isFinite(range.max) ? range.max : undefined;
  if (minimum === undefined && maximum === undefined) return undefined;
  const money = (amount: number) =>
    new Intl.NumberFormat("da-DK", { maximumFractionDigits: 2 }).format(amount);
  if (minimum !== undefined && maximum !== undefined && minimum !== maximum) {
    return `${money(minimum)}–${money(maximum)} kr.`;
  }
  return `${money(minimum ?? maximum!)} kr.`;
}

export function parseTicketbutlerList(value: unknown): {
  items: TicketbutlerListItem[];
  errors: string[];
} {
  if (!Array.isArray(value)) {
    return { items: [], errors: ["Ticketbutlers dagsliste er ikke en liste"] };
  }
  const items: TicketbutlerListItem[] = [];
  const errors: string[] = [];
  value.forEach((entryValue, index) => {
    const entry = object(entryValue);
    const id = safeInteger(entry?.pk);
    const slug = nonEmptyText(entry?.title_url);
    const start = parseZonedDate(entry?.start_date);
    if (id === undefined || !slug || !start) {
      errors.push(`Ticketbutlers dagslistepost ${index + 1} mangler id, slug eller starttid`);
      return;
    }
    const price = formatPriceRange(entry?.price_range);
    items.push({
      id,
      slug,
      date: start.toISODate()!,
      ...(price ? { price } : {}),
    });
  });
  return { items: deduplicateBy(items, (item) => String(item.id)), errors };
}

export function parseMotorfabrikkenEvent(
  value: unknown,
  listItem: TicketbutlerListItem,
  retrievedAt: string,
): { candidate?: NormalizedEventDraft; errors: string[] } {
  const event = object(value);
  const errors: string[] = [];
  if (!event) return { errors: ["Ticketbutler-detaljen er ikke et objekt"] };
  const id = safeInteger(event?.pk);
  const uuid = nonEmptyText(event?.uuid);
  const title = nonEmptyText(event?.title);
  const slug = nonEmptyText(event?.title_url);
  const start = parseZonedDate(event?.start_date);
  const end = event?.end_date === null || event?.end_date === undefined
    ? undefined
    : parseZonedDate(event.end_date);
  const address = object(event?.address);

  if (id !== listItem.id) errors.push("Ticketbutler-detaljen har et andet event-id end dagslisten");
  if (!uuid || !/^[a-f0-9-]{16,}$/i.test(uuid)) errors.push("Ticketbutler-detaljen mangler UUID");
  if (!title || !slug || slug !== listItem.slug) errors.push("Ticketbutler-detaljen mangler titel eller stabil slug");
  if (!start || (event?.end_date !== null && event?.end_date !== undefined && !end)) {
    errors.push("Ticketbutler-detaljen har et ugyldigt tidsinterval");
  }
  if (event?.timezone !== COPENHAGEN) errors.push("Ticketbutler-eventet bruger ikke København-tidszonen");
  if (
    !/motorfabrikken marstal/i.test(nonEmptyText(address?.venue) || "") ||
    address?.postcode !== "5960" ||
    !/^marstal$/i.test(nonEmptyText(address?.city) || "")
  ) {
    errors.push("Ticketbutler-eventet har ikke Motorfabrikken som valideret spillested");
  }
  if (boolean(event?.is_deleted) === undefined || boolean(event?.is_sold_out) === undefined) {
    errors.push("Ticketbutler-detaljen mangler statusfelter");
  }
  if (errors.length > 0 || id === undefined || !uuid || !title || !slug || !start) {
    return { errors };
  }

  const sourceUrl = sameOriginHttpsUrl(`/da/e/${encodeURIComponent(slug)}/`, TENANT_ORIGIN);
  const description = descriptionText(event.description);
  const free = event.is_free_event === true;
  const price = free ? "Gratis" : listItem.price;
  const street = nonEmptyText(address?.street);
  return {
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId: String(id),
      stableId: `${definition.id}-${id}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: {
        name: nonEmptyText(address?.venue)!,
        ...(street ? { address: street } : {}),
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [{
        id: `ticketbutler-${uuid}`,
        date: start.toISODate()!,
        startTime: start.toFormat("HH:mm"),
        ...(end && end.toISODate() !== start.toISODate() ? { endDate: end.toISODate()! } : {}),
        ...(end ? { endTime: end.toFormat("HH:mm") } : {}),
        allDay: false,
        timeUnknown: false,
      }],
      status: event.is_deleted === true ? "cancelled" : "scheduled",
      availability: event.is_sold_out === true ? "sold-out" : "available",
      attendance: "registration",
      attendanceDetails: event.is_sold_out === true
        ? "Udsolgt; se billetsiden for eventuel venteliste."
        : "Billet eller tilmelding kræves.",
      ...(price ? { price } : {}),
      bookingUrl: sourceUrl,
      bookingRequired: true,
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: String(id),
        sourceUrl,
        retrievedAt,
      },
    },
  };
}

async function ticketbutlerJson(context: CollectionContext, path: string): Promise<unknown> {
  return fetchJson(context, `${API_BASE}${path}`, {
    expectedOrigin: API_ORIGIN,
    headers: TENANT_HEADERS,
  });
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  let pagesFetched = 0;
  try {
    const tenant = await ticketbutlerJson(context, "/whitelabel/details/checkout/");
    pagesFetched += 1;
    errors.push(...validateMotorfabrikkenTenant(tenant));

    const start = DateTime.fromJSDate(context.now, { zone: COPENHAGEN }).startOf("month");
    const rangeEnd = DateTime.fromJSDate(context.now, { zone: COPENHAGEN }).plus({ months: 12 }).endOf("day");
    const calendarItems: TicketbutlerCalendarItem[] = [];
    for (let offset = 0; offset <= 12 && errors.length === 0; offset += 1) {
      const month = start.plus({ months: offset });
      const payload = await ticketbutlerJson(
        context,
        `/events/calendar/?year=${month.year}&month=${month.month}`,
      );
      pagesFetched += 1;
      const parsed = parseTicketbutlerCalendar(payload);
      errors.push(...parsed.errors);
      calendarItems.push(
        ...parsed.items.filter((item) => item.date <= rangeEnd.toISODate()!),
      );
    }

    const uniqueCalendarItems = deduplicateBy(calendarItems, (item) => String(item.id));
    if (uniqueCalendarItems.length !== calendarItems.length) {
      warnings.push("Ticketbutlers månedskalendere indeholdt samme event flere gange");
    }
    if (uniqueCalendarItems.length > MAX_EVENTS) {
      errors.push(`Ticketbutler returnerede flere end ${MAX_EVENTS} events`);
    }

    const listItems: TicketbutlerListItem[] = [];
    const expectedIds = new Set(uniqueCalendarItems.map((item) => item.id));
    for (const date of [...new Set(uniqueCalendarItems.map((item) => item.date))]) {
      if (errors.length > 0) break;
      const payload = await ticketbutlerJson(context, `/events/list/?date=${date}`);
      pagesFetched += 1;
      const parsed = parseTicketbutlerList(payload);
      errors.push(...parsed.errors);
      listItems.push(...parsed.items.filter((item) => expectedIds.has(item.id)));
    }

    const uniqueListItems = deduplicateBy(listItems, (item) => String(item.id));
    const returnedIds = new Set(uniqueListItems.map((item) => item.id));
    for (const id of expectedIds) {
      if (!returnedIds.has(id)) errors.push(`Ticketbutler-event ${id} mangler på den forventede dagsliste`);
    }

    for (const item of uniqueListItems) {
      if (errors.length > 0) break;
      const payload = await ticketbutlerJson(
        context,
        `/events/title/${encodeURIComponent(item.slug)}/`,
      );
      pagesFetched += 1;
      const parsed = parseMotorfabrikkenEvent(payload, item, retrievedAt);
      errors.push(...parsed.errors.map((error) => `${item.id}: ${error}`));
      if (parsed.candidate) candidates.push(parsed.candidate);
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
      warnings,
    };
  } catch (error) {
    return {
      status: pagesFetched > 0 ? "partial" : "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings,
      ...(pagesFetched > 0 ? { discardedCandidateCount: candidates.length } : {}),
    } as CollectionResult;
  }
}

export const motorfabrikkenSource: SourceAdapter = { definition, collect };
