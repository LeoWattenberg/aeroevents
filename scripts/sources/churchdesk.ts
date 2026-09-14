import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText } from "./http";
import { cleanText, slug } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  RecurringScheduleDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-kirkeliv"];
const COPENHAGEN = "Europe/Copenhagen";
const MAX_PAGES = 100;
const MAX_PAGINATION_PASSES = 3;
const CHURCHDESK_ORIGIN = new URL(definition.url).origin;

interface ChurchDeskSeriesDefinition {
  sourceEventId: string;
  title: string;
  organizerId: string;
  location: EventLocationDraft;
  startTime: string;
  weekday: number;
  weekdayCode: "WE" | "TH";
  intervalWeeks: number;
}

/**
 * ChurchDesk exposes the occurrences below as unrelated event IDs and does
 * not include a parent-series identifier. Keep this list deliberately narrow:
 * these are the three programmes whose checked source schedule establishes a
 * regular series. Generic titles such as "Gudstjeneste Marstal" must remain
 * individual events even when a short run happens to share a weekday.
 */
const CHURCHDESK_SERIES: readonly ChurchDeskSeriesDefinition[] = [
  {
    sourceEventId: "series-babysalmesang-i-tranderup",
    title: "Babysalmesang i Tranderup",
    organizerId: "linda-skjoennemand",
    location: {
      name: "Tranderup sognehus",
      address: "Tranderupgade",
      postalCode: "5970",
      city: "Ærøskøbing",
    },
    startTime: "10:00",
    weekday: 3,
    weekdayCode: "WE",
    intervalWeeks: 1,
  },
  {
    sourceEventId: "series-tumlingemusik-i-tranderup",
    title: "Tumlingemusik i Tranderup",
    organizerId: "linda-skjoennemand",
    location: {
      name: "Tranderup kirke",
      address: "Tranderupvej 49",
      postalCode: "5970",
      city: "Ærøskøbing",
    },
    startTime: "15:30",
    weekday: 4,
    weekdayCode: "TH",
    intervalWeeks: 1,
  },
  {
    sourceEventId: "series-bibelstudiekreds-marstal",
    title: "Bibelstudiekreds i Johannesevangeliet / Marstal Menigehedshus",
    organizerId: "pia-vandrup",
    location: {
      name: "Marstal Menighedshus",
      address: "Strandstræde 20",
      postalCode: "5960",
      city: "Marstal",
    },
    startTime: "19:00",
    weekday: 4,
    weekdayCode: "TH",
    intervalWeeks: 2,
  },
] as const;

interface ChurchDeskItem {
  id?: unknown;
  title?: unknown;
  cancelledAt?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  description?: unknown;
  summary?: unknown;
  contributor?: unknown;
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

function organizerName(value: unknown): string | undefined {
  const contributor = optionalString(value);
  if (!contributor) return undefined;
  return cleanText(contributor.replace(/^(?:v\.?|ved)\s+/iu, "")) || undefined;
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
  const eventOrganizer = organizerName(item.contributor);
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
      organizerId: eventOrganizer ? slug(eventOrganizer) : definition.organizerId,
      ...(eventOrganizer ? { organizerName: eventOrganizer } : {}),
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

function sameLocation(
  left: EventLocationDraft | undefined,
  right: EventLocationDraft,
): boolean {
  if (!left) return false;
  return left.name === right.name &&
    left.address === right.address &&
    left.postalCode === right.postalCode &&
    left.city === right.city &&
    left.url === right.url;
}

function matchingSeries(
  candidate: NormalizedEventDraft,
): ChurchDeskSeriesDefinition | undefined {
  if (candidate.occurrences.length !== 1 || candidate.schedule) return undefined;
  const occurrence = candidate.occurrences[0]!;
  if (
    occurrence.allDay ||
    occurrence.timeUnknown ||
    occurrence.endTime !== undefined ||
    occurrence.location !== undefined
  ) {
    return undefined;
  }
  return CHURCHDESK_SERIES.find((series) =>
    candidate.title === series.title &&
    candidate.organizerId === series.organizerId &&
    sameLocation(candidate.location, series.location) &&
    occurrence.startTime === series.startTime
  );
}

function comparableSeriesMetadata(candidate: NormalizedEventDraft): string {
  const {
    sourceEventId: _sourceEventId,
    stableId: _stableId,
    schedule: _schedule,
    occurrences: _occurrences,
    status: _status,
    provenance: _provenance,
    ...metadata
  } = candidate;
  return JSON.stringify(metadata);
}

function compactLocalDateTime(date: string, time: string): string {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function recurringScheduleFor(
  series: ChurchDeskSeriesDefinition,
  candidates: NormalizedEventDraft[],
): RecurringScheduleDraft | undefined {
  const observations = candidates
    .map((candidate) => ({ candidate, occurrence: candidate.occurrences[0]! }))
    .sort((left, right) =>
      `${left.occurrence.date}T${left.occurrence.startTime}`.localeCompare(
        `${right.occurrence.date}T${right.occurrence.startTime}`,
      ),
    );
  const first = observations[0];
  if (!first) return undefined;
  const firstDate = DateTime.fromISO(first.occurrence.date, { zone: COPENHAGEN }).startOf("day");
  if (!firstDate.isValid || firstDate.weekday !== series.weekday) return undefined;

  const recurrenceIds = new Set<string>();
  for (const { occurrence } of observations) {
    const date = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN }).startOf("day");
    const elapsedDays = date.diff(firstDate, "days").days;
    const recurrenceId = `${occurrence.date}T${series.startTime}`;
    if (
      !date.isValid ||
      date.weekday !== series.weekday ||
      occurrence.startTime !== series.startTime ||
      !Number.isSafeInteger(elapsedDays) ||
      elapsedDays < 0 ||
      elapsedDays % (series.intervalWeeks * 7) !== 0 ||
      recurrenceIds.has(recurrenceId)
    ) {
      return undefined;
    }
    recurrenceIds.add(recurrenceId);
  }

  const last = observations.at(-1)!;
  const lastDate = DateTime.fromISO(last.occurrence.date, { zone: COPENHAGEN }).startOf("day");
  const exdates: string[] = [];
  for (
    let cursor = firstDate;
    cursor <= lastDate;
    cursor = cursor.plus({ weeks: series.intervalWeeks })
  ) {
    const recurrenceId = `${cursor.toISODate()}T${series.startTime}`;
    if (!recurrenceIds.has(recurrenceId)) exdates.push(recurrenceId);
  }

  return {
    kind: "recurring",
    dtstart: {
      kind: "timed",
      date: first.occurrence.date,
      startTime: series.startTime,
    },
    rrule:
      `FREQ=WEEKLY;${series.intervalWeeks > 1 ? `INTERVAL=${series.intervalWeeks};` : ""}` +
      `BYDAY=${series.weekdayCode};UNTIL=${compactLocalDateTime(last.occurrence.date, series.startTime)}`,
    rdates: [],
    exdates,
    overrides: observations.flatMap(({ candidate, occurrence }) => {
      const status = occurrence.status ?? candidate.status;
      return status === "scheduled"
        ? []
        : [{ recurrenceId: `${occurrence.date}T${series.startTime}`, status }];
    }),
  };
}

/** Consolidate only the three ChurchDesk programmes whose recurrence is known. */
export function consolidateChurchDeskSeries(
  candidates: NormalizedEventDraft[],
): {
  candidates: NormalizedEventDraft[];
  absorbedSourceEventIds: string[];
  warnings: string[];
} {
  const groups = new Map<ChurchDeskSeriesDefinition, NormalizedEventDraft[]>();
  const untouched: NormalizedEventDraft[] = [];
  for (const candidate of candidates) {
    const series = matchingSeries(candidate);
    if (!series) {
      untouched.push(candidate);
      continue;
    }
    const group = groups.get(series) ?? [];
    group.push(candidate);
    groups.set(series, group);
  }

  const consolidated: NormalizedEventDraft[] = [];
  const absorbedSourceEventIds: string[] = [];
  const retiredSeriesSourceEventIds: string[] = [];
  const warnings: string[] = [];
  for (const series of CHURCHDESK_SERIES) {
    const group = groups.get(series);
    if (!group) {
      retiredSeriesSourceEventIds.push(series.sourceEventId);
      continue;
    }
    const metadata = new Set(group.map(comparableSeriesMetadata));
    const schedule = metadata.size === 1 ? recurringScheduleFor(series, group) : undefined;
    if (!schedule) {
      warnings.push(
        `ChurchDesk-serien “${series.title}” kunne ikke samles sikkert; de enkelte events blev bevaret`,
      );
      consolidated.push(...group);
      retiredSeriesSourceEventIds.push(series.sourceEventId);
      continue;
    }

    const observations = group
      .flatMap((candidate) => candidate.occurrences)
      .sort((left, right) =>
        `${left.date}T${left.startTime ?? ""}`.localeCompare(
          `${right.date}T${right.startTime ?? ""}`,
        ),
      );
    const representative = group.find(({ status }) => status === "scheduled") ?? group[0]!;
    consolidated.push({
      ...representative,
      sourceEventId: series.sourceEventId,
      stableId: `${definition.id}-${series.sourceEventId}`,
      schedule,
      occurrences: observations,
      status: "scheduled",
      provenance: {
        ...representative.provenance,
        externalId: series.sourceEventId,
        sourceUrl: definition.url,
      },
    });
    absorbedSourceEventIds.push(...group.map(({ sourceEventId }) => sourceEventId));
  }

  return {
    candidates: [...untouched, ...consolidated].sort((left, right) => {
      const leftOccurrence = left.occurrences[0];
      const rightOccurrence = right.occurrences[0];
      return `${leftOccurrence?.date ?? ""}T${leftOccurrence?.startTime ?? ""}`.localeCompare(
        `${rightOccurrence?.date ?? ""}T${rightOccurrence?.startTime ?? ""}`,
      ) || left.sourceEventId.localeCompare(right.sourceEventId);
    }),
    absorbedSourceEventIds: [...absorbedSourceEventIds, ...retiredSeriesSourceEventIds],
    warnings,
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
  const collectedById = new Map<string, NormalizedEventDraft>();
  const warnings: string[] = [];
  const errors: string[] = [];
  let pagesFetched = 0;
  let expectedTotal: number | undefined;
  let totalPages: number | undefined;
  let sawIdenticalOverlap = false;

  try {
    pagination: for (let pass = 1; pass <= MAX_PAGINATION_PASSES; pass += 1) {
      for (let page = 1; page <= (totalPages ?? 1); page += 1) {
        const html = await fetchText(context, churchDeskPageUrl(page), {
          expectedOrigin: CHURCHDESK_ORIGIN,
        });
        pagesFetched += 1;
        const parsed = parseChurchDeskPage(html, retrievedAt);
        warnings.push(...parsed.warnings);
        errors.push(...parsed.errors);
        if (!parsed.payload) break pagination;

        if (parsed.payload.pageNumber !== page) {
          errors.push(
            `ChurchDesk returnerede side ${parsed.payload.pageNumber}, forventede side ${page}`,
          );
          break pagination;
        }
        if (expectedTotal === undefined) {
          expectedTotal = parsed.payload.total;
          totalPages = parsed.payload.totalPages;
        } else if (
          parsed.payload.total !== expectedTotal ||
          parsed.payload.totalPages !== totalPages
        ) {
          errors.push("ChurchDesk-pagination ændrede sig under indsamlingen");
          break pagination;
        }
        if (page === 1 && (expectedTotal === 0 || parsed.candidates.length === 0)) {
          errors.push("ChurchDesk returnerede ingen begivenheder; snapshot beholdes");
          break pagination;
        }

        for (const candidate of parsed.candidates) {
          const existing = collectedById.get(candidate.sourceEventId);
          if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
            errors.push(
              `ChurchDesk returnerede modstridende data for begivenhed ${candidate.sourceEventId}`,
            );
            break pagination;
          }
          if (existing) sawIdenticalOverlap = true;
          else collectedById.set(candidate.sourceEventId, candidate);
        }
        if (parsed.errors.length > 0) break pagination;
      }

      if (expectedTotal !== undefined && collectedById.size === expectedTotal) break;
      if (pass < MAX_PAGINATION_PASSES) {
        warnings.push(
          `ChurchDesk-pagination overlappede; genlæser siderne for at finde alle ${expectedTotal ?? "oplyste"} begivenheder`,
        );
      } else {
        break;
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
        errors: [message],
        warnings,
      };
    }
    errors.push(message);
  }

  const collected = [...collectedById.values()];
  if (sawIdenticalOverlap && collected.length === expectedTotal) {
    warnings.push("ChurchDesk returnerede overlappende sider; identiske event-ID'er blev samlet sikkert");
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

  const series = consolidateChurchDeskSeries(collected);
  warnings.push(...series.warnings);

  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates: series.candidates,
    excludedSourceEventIds: series.absorbedSourceEventIds,
    errors: [],
    warnings: [...new Set(warnings)],
  };
}

export const churchDeskSource: SourceAdapter = { definition, collect };
