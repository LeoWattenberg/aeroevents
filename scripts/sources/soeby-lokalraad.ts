import { createHash } from "node:crypto";

import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  Attendance,
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["soeby-lokalraad"];
const SOEBY_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";

const MONTHS = new Map<string, number>([
  ["januar", 1],
  ["jan", 1],
  ["februar", 2],
  ["feb", 2],
  ["marts", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["maj", 5],
  ["juni", 6],
  ["jun", 6],
  ["juli", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sept", 9],
  ["sep", 9],
  ["oktober", 10],
  ["okt", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

const MONTH_PATTERN =
  "januar|jan|februar|feb|marts|mar|april|apr|maj|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|december|dec";

type LocalEventKind = "book-distribution" | "board-meeting" | "annual-meeting" | "open-house";

interface ParsedDates {
  dates: string[];
  inheritedYear: boolean;
}

interface ParsedClock {
  startTime: string;
  endTime?: string;
}

interface RawLocalEvent {
  kind: LocalEventKind;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime?: string;
  inheritedYear: boolean;
  status: EventStatus;
  attendance: Attendance;
}

export interface SoebyLokalraadParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

function classifyEventBlock(value: string): LocalEventKind | undefined {
  if (/\bbøger(?:ne)?\b.*\budleveres\b/i.test(value)) return "book-distribution";
  if (/\bnæste\s+møde\b.*\b(?:aftalt|bliver|afholdes)\b/i.test(value)) {
    return "board-meeting";
  }
  if (/årsmødet\s+afholdes\b/i.test(value)) return "annual-meeting";
  if (
    /åbent\s+hus\b/i.test(value) &&
    /\b(?:arrangement|afholdes|inviterer|vi\s+laver)\b/i.test(value)
  ) {
    return "open-house";
  }
  return undefined;
}

function eventTitle(kind: LocalEventKind): string {
  switch (kind) {
    case "book-distribution":
      return "Åbent hus med bogudlevering i Aktivitetshuset";
    case "board-meeting":
      return "Bestyrelsesmøde i Søby Lokalråd";
    case "annual-meeting":
      return "Årsmøde i Søby Lokalråd";
    case "open-house":
      return "Åbent hus i Aktivitetshuset";
  }
}

function eventAttendance(kind: LocalEventKind): Attendance {
  return kind === "board-meeting" ? "unknown" : "public";
}

function parseDates(value: string, contextYear: number | undefined): ParsedDates | undefined {
  const normalized = cleanText(value).toLocaleLowerCase("da-DK");
  const match = normalized.match(
    new RegExp(
      `(?:\\bden\\s+|\\bd\\.?\\s+)?((?:\\d{1,2}\\.?\\s*(?:\\+\\s*|og\\s+|&\\s*|,\\s*))*\\d{1,2}\\.?)\\s+(${MONTH_PATTERN})\\.?(?:\\s+(20\\d{2}))?`,
      "i",
    ),
  );
  if (!match?.[1] || !match[2]) return undefined;
  const month = MONTHS.get(match[2].replace(/\.$/, ""));
  const explicitYear = match[3] ? Number(match[3]) : undefined;
  const year = explicitYear ?? contextYear;
  if (!month || !year) return undefined;

  const days = [...match[1].matchAll(/\d{1,2}/g)].map((day) => Number(day[0]));
  if (days.length === 0 || days.some((day) => !validCalendarDate(year, month, day))) {
    return undefined;
  }
  return {
    dates: [...new Set(days.map((day) => isoDate(year, month, day)))],
    inheritedYear: explicitYear === undefined,
  };
}

function clock(hourValue: string, minuteValue: string | undefined): string | undefined {
  const hour = Number(hourValue);
  const minute = minuteValue === undefined ? 0 : Number(minuteValue);
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseClock(value: string): ParsedClock | undefined {
  const normalized = cleanText(value);
  const match = normalized.match(
    /\bkl(?:okken)?\.?\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?)?/i,
  );
  if (!match?.[1]) return undefined;
  const remainder = normalized.slice((match.index ?? 0) + match[0].length);
  if (!match[3] && /^\s*[-–—]/.test(remainder)) return undefined;
  const startTime = clock(match[1], match[2]);
  const endTime = match[3] ? clock(match[3], match[4]) : undefined;
  if (!startTime || (match[3] && !endTime)) return undefined;
  return { startTime, ...(endTime ? { endTime } : {}) };
}

function eventStatus(value: string): EventStatus {
  if (/\baflyst\b/i.test(value)) return "cancelled";
  if (/\b(?:udsat|udskudt|flyttet)\b/i.test(value)) return "postponed";
  return "scheduled";
}

function isFutureOccurrence(
  date: string,
  startTime: string,
  endTime: string | undefined,
  now: DateTime,
): boolean {
  const boundary = DateTime.fromISO(`${date}T${endTime ?? startTime}`, { zone: COPENHAGEN });
  return boundary.isValid && boundary >= now;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function normalizedSignature(event: RawLocalEvent): string {
  return [
    event.kind,
    event.title,
    event.description.toLocaleLowerCase("da-DK"),
    event.date,
    event.startTime,
    event.endTime ?? "",
  ].join("|");
}

function baseExternalId(nodeId: string, event: RawLocalEvent): string {
  return `node-${nodeId}-${event.date}-${event.startTime.replace(":", "-")}`;
}

function expectedNodeId(): string | undefined {
  return new URL(definition.url).pathname.match(/\/node\/(\d+)\/?$/)?.[1];
}

export function parseSoebyLokalraadPage(
  html: string,
  retrievedAt: string,
  pageUrl = definition.url,
): SoebyLokalraadParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  const expectedId = expectedNodeId();
  const pageTitle = cleanText($("title").first().text());
  if (!/Søby\s+Lokalråd/i.test(pageTitle)) {
    errors.push("Søby Lokalråds side mangler den forventede sidetitel");
  }

  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = canonicalHref
      ? sameOriginHttpsUrl(absoluteUrl(canonicalHref, pageUrl), SOEBY_ORIGIN)
      : undefined;
  } catch (error) {
    errors.push(`Søby Lokalråds canonical-link er usikkert: ${errorMessage(error)}`);
  }
  const canonicalNodeId = canonicalUrl
    ? new URL(canonicalUrl).pathname.match(/\/node\/(\d+)\/?$/)?.[1]
    : undefined;
  if (!canonicalHref || !canonicalNodeId || canonicalNodeId !== expectedId) {
    errors.push("Søby Lokalråds canonical-link peger ikke entydigt på den forventede Drupal-node");
  }

  const articles = expectedId
    ? $(`article[data-history-node-id='${expectedId}']`)
    : $("article[data-history-node-id]");
  if (articles.length !== 1) {
    errors.push(
      articles.length === 0
        ? "Søby Lokalråds side mangler den forventede Drupal-node"
        : "Søby Lokalråds side indeholder Drupal-noden flere gange",
    );
  }
  const nodeId = cleanText(articles.first().attr("data-history-node-id") ?? "");
  const bodies = articles.first().find(".field.field-body");
  if (bodies.length !== 1) {
    errors.push("Søby Lokalråds Drupal-node mangler den entydige referattekst");
  }
  const tables = bodies.first().children("table.table");
  if (tables.length !== 1) {
    errors.push("Søby Lokalråds referatside mangler den forventede referattabel");
  }
  const contentCell = tables.first().find("> tbody > tr").eq(1).children("td").first();
  if (contentCell.length !== 1) {
    errors.push("Søby Lokalråds referattabel mangler kolonnen med mødereferater");
  }

  const now = DateTime.fromISO(retrievedAt, { setZone: true }).setZone(COPENHAGEN);
  if (!now.isValid) errors.push("Indsamlingstidspunktet for Søby Lokalråd er ugyldigt");
  if (errors.length > 0 || !canonicalUrl || !nodeId || !now.isValid) {
    return { candidates, warnings, errors: [...new Set(errors)] };
  }

  const rawEvents: RawLocalEvent[] = [];
  let sectionYear: number | undefined;
  let historicalOccurrenceCount = 0;
  for (const element of contentCell.children().toArray()) {
    const tagName = element.type === "tag" ? element.name.toLowerCase() : "";
    if (tagName === "hr") {
      sectionYear = undefined;
      continue;
    }
    const text = cleanText($(element).text());
    if (!text) continue;

    if (/\breferat\s+af\b/i.test(text)) {
      sectionYear = text.match(/\b(20\d{2})\b/)?.[1]
        ? Number(text.match(/\b(20\d{2})\b/)![1])
        : undefined;
    } else if (/^Dato\s*:/i.test(text)) {
      const year = text.match(/\b(20\d{2})\b/)?.[1];
      if (year) sectionYear = Number(year);
    }

    const kind = classifyEventBlock(text);
    if (!kind) continue;
    const parsedDates = parseDates(text, sectionYear);
    if (!parsedDates) {
      const blockYear = text.match(/\b(20\d{2})\b/)?.[1];
      const relevantYear = blockYear ? Number(blockYear) : sectionYear;
      if (relevantYear === undefined || relevantYear >= now.year) {
        errors.push(`En event-lignende blok på Søby Lokalråds side har en ugyldig dato: ${text}`);
      }
      continue;
    }

    const potentiallyFuture = parsedDates.dates.filter(
      (date) => date >= (now.toISODate() ?? ""),
    );
    historicalOccurrenceCount += parsedDates.dates.length - potentiallyFuture.length;
    if (potentiallyFuture.length === 0) continue;

    const parsedClock = parseClock(text);
    if (!parsedClock) {
      errors.push(`En kommende event-lignende blok på Søby Lokalråds side har et ugyldigt klokkeslæt: ${text}`);
      continue;
    }
    if (parsedClock.endTime && parsedClock.endTime <= parsedClock.startTime) {
      errors.push(`En kommende event-lignende blok på Søby Lokalråds side slutter ikke efter start: ${text}`);
      continue;
    }

    for (const date of potentiallyFuture) {
      if (!isFutureOccurrence(date, parsedClock.startTime, parsedClock.endTime, now)) {
        historicalOccurrenceCount += 1;
        continue;
      }
      rawEvents.push({
        kind,
        title: eventTitle(kind),
        description: text,
        date,
        startTime: parsedClock.startTime,
        ...(parsedClock.endTime ? { endTime: parsedClock.endTime } : {}),
        inheritedYear: parsedDates.inheritedYear,
        status: eventStatus(text),
        attendance: eventAttendance(kind),
      });
    }
  }

  if (historicalOccurrenceCount > 0) {
    warnings.push(
      `${historicalOccurrenceCount} historiske forekomst${historicalOccurrenceCount === 1 ? "" : "er"} på referatsiden blev udeladt`,
    );
  }

  const uniqueRawEvents: RawLocalEvent[] = [];
  const seenSignatures = new Set<string>();
  for (const event of rawEvents) {
    const signature = normalizedSignature(event);
    if (seenSignatures.has(signature)) {
      warnings.push("Søby Lokalråds referatside gentog en identisk eventforekomst");
      continue;
    }
    seenSignatures.add(signature);
    uniqueRawEvents.push(event);
  }

  const baseCounts = new Map<string, number>();
  for (const event of uniqueRawEvents) {
    const base = baseExternalId(nodeId, event);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  for (const event of uniqueRawEvents.sort((left, right) =>
    `${left.date}T${left.startTime}|${left.title}`.localeCompare(
      `${right.date}T${right.startTime}|${right.title}`,
    )
  )) {
    const base = baseExternalId(nodeId, event);
    const sourceEventId = (baseCounts.get(base) ?? 0) > 1
      ? `${base}-${digest(normalizedSignature(event))}`
      : base;
    const reviewReasons = [
      "Arrangementet er udledt af en løbende Drupal-referatside, hvor én node indeholder flere aktiviteter.",
    ];
    if (event.inheritedYear) {
      reviewReasons.push(
        "Årstallet fremgår af referatets mødedato og er arvet af arrangementsdatoen.",
      );
    }
    if (event.kind === "board-meeting") {
      reviewReasons.push("Referatet oplyser ikke, om bestyrelsesmødet er offentligt.");
    }

    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title: event.title,
      description: event.description,
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(/Aktivitetshuset/i.test(event.description)
        ? { location: { name: "Aktivitetshuset", city: "Søby" } }
        : {}),
      occurrences: [{
        id: `${sourceEventId}-occurrence`,
        date: event.date,
        startTime: event.startTime,
        ...(event.endTime ? { endTime: event.endTime } : {}),
        allDay: false,
        timeUnknown: false,
        status: event.status,
      }],
      status: event.status,
      availability: "unknown",
      attendance: event.attendance,
      ...(event.attendance === "unknown"
        ? { attendanceDetails: "Referatet oplyser ikke adgangsvilkår." }
        : {}),
      publication: "review",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: canonicalUrl,
        retrievedAt,
      },
    });
  }

  const ids = candidates.map((candidate) => candidate.sourceEventId);
  if (new Set(ids).size !== ids.length) {
    errors.push("Søby Lokalråds sammensatte event-ID'er er ikke entydige");
  }
  return {
    candidates,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: SOEBY_ORIGIN,
    });
    const parsed = parseSoebyLokalraadPage(html, retrievedAt, definition.url);
    if (parsed.candidates.length === 0) {
      parsed.errors.push("Søby Lokalråds referatside returnerede ingen kommende events; snapshot beholdes");
    }
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: [...new Set(parsed.errors)],
        warnings: [...new Set(parsed.warnings)],
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      errors: [],
      warnings: [...new Set(parsed.warnings)],
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const soebyLokalraadSource: SourceAdapter = { definition, collect };
