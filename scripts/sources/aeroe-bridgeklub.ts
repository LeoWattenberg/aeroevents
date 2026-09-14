import { load } from "cheerio";
import { DateTime } from "luxon";

import { normalizedTime } from "./fixed-schedule";
import { cleanText, slug } from "./html";
import { errorMessage, fetchSourceResponse } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-bridgeklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const CLUB_DETAILS_URL = "https://www.bridge.dk/4596/Klubben.html";
const COPENHAGEN = "Europe/Copenhagen";
const MAX_ROWS = 30;
const REVIEW_REASON =
  "BridgeCentral har ingen event-ID'er; sæson og semantisk bloknavn bruges som stabil identitet og skal kontrolleres før publicering";

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
const MONTH_PATTERN = [...MONTHS.keys()].join("|");
const WEEKDAYS = new Map<string, number>([
  ["mandag", 1],
  ["tirsdag", 2],
  ["onsdag", 3],
  ["torsdag", 4],
  ["fredag", 5],
  ["lørdag", 6],
  ["søndag", 7],
]);

interface Season {
  startYear: number;
  endYear: number;
  label: string;
}

interface ScheduleRow {
  dates: string[];
  text: string;
  detail: string;
  explicitStartTime?: string;
  status: EventStatus;
  offIsland: boolean;
}

interface ClubDetails {
  location: NonNullable<NormalizedEventDraft["location"]>;
  mondayStart: string;
  wednesdayStart: string;
  mondayDeadline: string;
  wednesdayDeadline: string;
  price: string;
}

export interface AeroeBridgeklubParseResult {
  candidates: NormalizedEventDraft[];
  excludedSourceEventIds: string[];
  warnings: string[];
  errors: string[];
  rawRowCount: number;
}

function dateForSeason(day: number, monthName: string, season: Season): DateTime | undefined {
  const month = MONTHS.get(monthName.toLocaleLowerCase("da-DK"));
  if (!month) return undefined;
  const year = month >= 7 ? season.startYear : season.endYear;
  const date = DateTime.fromObject({ year, month, day }, { zone: COPENHAGEN });
  return date.isValid && date.year === year && date.month === month && date.day === day
    ? date.startOf("day")
    : undefined;
}

function titleFromDetail(detail: string, fallback: string): string {
  const value = cleanText(
    detail
      .replace(/^\s*[,.;:-]+\s*/u, "")
      .replace(/\bkl\.?\s*\d{1,2}(?:[.:]\d{2})?\b/iu, "")
      .replace(/\btil\s+Langeland\b/iu, "")
      .replace(/^[\s,.;:-]+|[\s.]+$/gu, ""),
  );
  if (!value) return fallback;
  return value[0]!.toLocaleUpperCase("da-DK") + value.slice(1);
}

function parseRow(
  value: string,
  season: Season,
  expectedWeekday: number | "weekend",
  errors: string[],
): ScheduleRow | undefined {
  const match = cleanText(value).match(
    new RegExp(
      `^(?:(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\\s+)?(?:(?:d\\.?|den)\\s*)?(\\d{1,2})\\.?\\s*(${MONTH_PATTERN})(?:\\s*[–—-]\\s*(\\d{1,2})\\.?\\s*(${MONTH_PATTERN}))?(.*)$`,
      "iu",
    ),
  );
  if (!match?.[2] || !match[3]) {
    errors.push(`Ærø Bridgeklubs sæsonplan har en linje i et ukendt datoformat: ${value}`);
    return undefined;
  }

  const first = dateForSeason(Number(match[2]), match[3], season);
  const last = match[4] && match[5]
    ? dateForSeason(Number(match[4]), match[5], season)
    : first;
  if (!first || !last || last < first || last.diff(first, "days").days > 200) {
    errors.push(`Ærø Bridgeklubs sæsonplan har et ugyldigt datointerval: ${value}`);
    return undefined;
  }

  const prefixedWeekday = match[1]
    ? WEEKDAYS.get(match[1].toLocaleLowerCase("da-DK"))
    : undefined;
  const permitted = expectedWeekday === "weekend" ? [6, 7] : [expectedWeekday];
  if (
    !permitted.includes(first.weekday) ||
    !permitted.includes(last.weekday) ||
    (prefixedWeekday !== undefined && prefixedWeekday !== first.weekday) ||
    (expectedWeekday === "weekend" && last > first)
  ) {
    errors.push(`Ærø Bridgeklubs ugedag og dato stemmer ikke overens: ${value}`);
    return undefined;
  }

  const dates: string[] = [];
  for (let cursor = first; cursor <= last; cursor = cursor.plus({ weeks: 1 })) {
    dates.push(cursor.toISODate()!);
  }
  if (dates.at(-1) !== last.toISODate()) {
    errors.push(`Ærø Bridgeklubs datointerval følger ikke den angivne ugedag: ${value}`);
    return undefined;
  }

  const detail = cleanText(match[6] ?? "");
  const timeMatch = detail.match(/\bkl\.?\s*(\d{1,2})(?:[.:](\d{2}))?/iu);
  const explicitStartTime = timeMatch?.[1]
    ? normalizedTime(timeMatch[1], timeMatch[2] ?? "00")
    : undefined;
  if (timeMatch && !explicitStartTime) {
    errors.push(`Ærø Bridgeklubs sæsonplan har et ugyldigt klokkeslæt: ${value}`);
    return undefined;
  }
  return {
    dates,
    text: cleanText(value),
    detail,
    ...(explicitStartTime ? { explicitStartTime } : {}),
    status: /\baflyst\b/iu.test(detail)
      ? "cancelled"
      : /\b(?:udsat|flyttet)\b/iu.test(detail)
        ? "postponed"
        : "scheduled",
    offIsland: /\btil\s+Langeland\b/iu.test(detail),
  };
}

function sectionTime(value: string, label: string, errors: string[]): string | undefined {
  const match = value.match(/\bkl\.?\s*(\d{1,2})(?:[.:](\d{2}))?\s*:?$/iu);
  const time = match?.[1] ? normalizedTime(match[1], match[2] ?? "00") : undefined;
  if (!time) errors.push(`Ærø Bridgeklubs ${label}-sektion mangler et gyldigt starttidspunkt`);
  return time;
}

function parseClubDetails(html: string, errors: string[]): ClubDetails | undefined {
  const $ = load(html);
  if (cleanText($("title").first().text()) !== "Ærø Bridgeklub") {
    errors.push("Ærø Bridgeklubs infoside har en uventet titel");
  }
  const body = cleanText($("body").text());
  if (!/\bSpillested\b/iu.test(body) || !/\bSpilletidspunkt\b/iu.test(body)) {
    errors.push("Ærø Bridgeklubs infoside mangler spillested eller spilletider");
  }
  if (!/Vestergade\s+32B,?\s*1\.\s*sal,?\s*Marstal/iu.test(body)) {
    errors.push("Ærø Bridgeklubs infoside mangler det forventede spillested");
  }
  const monday = body.match(/Mandag\s+kl\.?\s*(\d{1,2})(?:[.:](\d{2}))?\s+Tilmelding\s+på\s+dagen\s+senest\s+kl\.?\s*(\d{1,2})(?:[.:](\d{2}))?/iu);
  const wednesday = body.match(/Onsdag\s+kl\.?\s*(\d{1,2})(?:[.:](\d{2}))?\s+Tilmelding\s+på\s+dagen\s+senest\s+kl\.?\s*(\d{1,2})(?:[.:](\d{2}))?/iu);
  const guestPrice = body.match(/Klubbens\s+medlemmer\s+spiller\s+gratis\s+og\s+gæster\s+betaler\s+(\d+)\.?\s*kr/iu);
  const mondayStart = monday?.[1] ? normalizedTime(monday[1], monday[2] ?? "00") : undefined;
  const mondayDeadline = monday?.[3] ? normalizedTime(monday[3], monday[4] ?? "00") : undefined;
  const wednesdayStart = wednesday?.[1] ? normalizedTime(wednesday[1], wednesday[2] ?? "00") : undefined;
  const wednesdayDeadline = wednesday?.[3] ? normalizedTime(wednesday[3], wednesday[4] ?? "00") : undefined;
  if (!mondayStart || !mondayDeadline || !wednesdayStart || !wednesdayDeadline || !guestPrice?.[1]) {
    errors.push("Ærø Bridgeklubs infoside mangler tilmeldingsfrister eller gæstepris");
  }
  if (errors.length > 0 || !mondayStart || !mondayDeadline || !wednesdayStart || !wednesdayDeadline || !guestPrice?.[1]) {
    return undefined;
  }
  return {
    location: {
      name: "Ærø Bridgeklub",
      address: "Vestergade 32B, 1. sal",
      postalCode: "5960",
      city: "Marstal",
    },
    mondayStart,
    wednesdayStart,
    mondayDeadline,
    wednesdayDeadline,
    price: `Medlemmer gratis; gæster ${guestPrice[1]} kr.`,
  };
}

function scheduleCandidate(
  sourceEventId: string,
  title: string,
  description: string,
  weekdayCode: "MO" | "WE",
  startTime: string,
  deadline: string,
  rows: ScheduleRow[],
  details: ClubDetails,
  retrievedAt: string,
  sourceModifiedAt: string | undefined,
  errors: string[],
): NormalizedEventDraft | undefined {
  if (rows.some((row) => row.explicitStartTime && row.explicitStartTime !== startTime)) {
    errors.push(`Ærø Bridgeklubs plan for ${title} indeholder et tidsafvigende enkeltforløb`);
    return undefined;
  }
  const statuses = new Set(rows.map((row) => row.status));
  if (statuses.size !== 1) {
    errors.push(`Ærø Bridgeklubs plan for ${title} indeholder flere statusser`);
    return undefined;
  }
  const dates = rows.flatMap((row) => row.dates).sort();
  if (dates.length === 0 || new Set(dates).size !== dates.length) {
    errors.push(`Ærø Bridgeklubs plan for ${title} er tom eller indeholder samme dato flere gange`);
    return undefined;
  }
  const first = DateTime.fromISO(dates[0]!, { zone: COPENHAGEN });
  const last = DateTime.fromISO(dates.at(-1)!, { zone: COPENHAGEN });
  const observed = new Set(dates);
  const exdates: string[] = [];
  for (let cursor = first; cursor <= last; cursor = cursor.plus({ weeks: 1 })) {
    const date = cursor.toISODate()!;
    if (!observed.has(date)) exdates.push(`${date}T${startTime}`);
  }
  const status = rows[0]!.status;
  return {
    sourceId: definition.id,
    sourceEventId,
    stableId: `${definition.id}-${sourceEventId}`,
    title,
    description,
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: details.location,
    ...(dates.length > 1
      ? {
          schedule: {
            kind: "recurring" as const,
            dtstart: {
              kind: "timed" as const,
              date: first.toISODate()!,
              startTime,
            },
            rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode};UNTIL=${last.toFormat("yyyyLLdd'T'")}${startTime.replace(":", "")}00`,
            rdates: [],
            exdates,
            overrides: [],
          },
          occurrences: [],
        }
      : {
          occurrences: [
            {
              id: `${sourceEventId}-occurrence-1`,
              date: dates[0]!,
              startTime,
              allDay: false,
              timeUnknown: false,
              status,
            },
          ],
        }),
    status,
    attendance: "registration",
    attendanceDetails: "Klubben oplyser, at gæster kan deltage.",
    price: details.price,
    bookingRequired: true,
    bookingDetails: `Tilmelding på spilledagen senest kl. ${deadline}. Se kildesiden for den aktuelle kontaktperson.`,
    publication: "review",
    reviewReasons: [
      REVIEW_REASON,
      "Sæsonplanen angiver starttid, men ikke sluttid",
    ],
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl: definition.url,
      retrievedAt,
      ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
    },
  };
}

function semanticKeys(
  rows: ScheduleRow[],
  fallbackTitle: string,
  special?: (row: ScheduleRow) => string | undefined,
): Array<{ title: string; key: string }> {
  const values = rows.map((row) => {
    const title = titleFromDetail(row.detail, fallbackTitle);
    const key = special?.(row) ?? slug(title).slice(0, 120);
    return { title, key: key || slug(fallbackTitle) };
  });
  const totals = new Map<string, number>();
  for (const value of values) totals.set(value.key, (totals.get(value.key) ?? 0) + 1);
  const seen = new Map<string, number>();
  return values.map((value) => {
    const ordinal = (seen.get(value.key) ?? 0) + 1;
    seen.set(value.key, ordinal);
    return {
      title: value.title,
      key: (totals.get(value.key) ?? 0) > 1 ? `${value.key}-${ordinal}` : value.key,
    };
  });
}

function currentAt(date: string, startTime: string, now: Date): boolean {
  const boundary = DateTime.fromISO(`${date}T${startTime}`, { zone: COPENHAGEN });
  return boundary.isValid && boundary >= DateTime.fromJSDate(now).setZone(COPENHAGEN);
}

export function parseAeroeBridgeklubPages(
  scheduleHtml: string,
  clubHtml: string,
  retrievedAt: string,
  now: Date,
  sourceModifiedAt?: string,
): AeroeBridgeklubParseResult {
  const $ = load(scheduleHtml);
  const warnings: string[] = [];
  const errors: string[] = [];
  const excludedSourceEventIds: string[] = [];
  if (cleanText($("title").first().text()) !== "Ærø Bridgeklub") {
    errors.push("Ærø Bridgeklubs sæsonside har en uventet titel");
  }
  if (cleanText($("th").first().text()) !== "Turneringsoversigt.") {
    errors.push("Ærø Bridgeklubs turneringsoversigt kan ikke identificeres");
  }
  const details = parseClubDetails(clubHtml, errors);
  const lines = $("p")
    .toArray()
    .map((element) => cleanText($(element).text()))
    .filter(Boolean);
  const seasonLines = lines.filter((line) => /^Turneringsoversigt for sæsonen\s+20\d{2}\/\d{2}$/iu.test(line));
  if (seasonLines.length !== 1) {
    errors.push("Ærø Bridgeklubs sæsonoverskrift mangler eller forekommer flere gange");
    return { candidates: [], excludedSourceEventIds, warnings, errors, rawRowCount: 0 };
  }
  const seasonMatch = seasonLines[0]!.match(/(20\d{2})\/(\d{2})$/u);
  const startYear = Number(seasonMatch?.[1]);
  const endYear = Math.floor(startYear / 100) * 100 + Number(seasonMatch?.[2]);
  if (!seasonMatch || endYear !== startYear + 1) {
    errors.push("Ærø Bridgeklubs sæsonår er ugyldigt");
    return { candidates: [], excludedSourceEventIds, warnings, errors, rawRowCount: 0 };
  }
  const season: Season = { startYear, endYear, label: `${startYear}-${seasonMatch[2]}` };

  const mondayIndex = lines.findIndex((line) => /^Mandage\s+kl\./iu.test(line));
  const wednesdayIndex = lines.findIndex((line) => /^Onsdage\s+kl\./iu.test(line));
  const weekendIndex = lines.findIndex((line) => /^Weekends\s+kl\./iu.test(line));
  const footerIndex = lines.findIndex((line, index) => index > weekendIndex && /^mvh\b/iu.test(line));
  if (
    mondayIndex < 0 ||
    wednesdayIndex <= mondayIndex + 1 ||
    weekendIndex <= wednesdayIndex + 1 ||
    footerIndex <= weekendIndex + 1
  ) {
    errors.push("Ærø Bridgeklubs tre forventede programsektioner mangler eller er tomme");
    return { candidates: [], excludedSourceEventIds, warnings, errors, rawRowCount: 0 };
  }
  const mondayTime = sectionTime(lines[mondayIndex]!, "mandags", errors);
  const wednesdayTime = sectionTime(lines[wednesdayIndex]!, "onsdags", errors);
  const weekendTime = sectionTime(lines[weekendIndex]!, "weekend", errors);
  if (details && (mondayTime !== details.mondayStart || wednesdayTime !== details.wednesdayStart)) {
    errors.push("Ærø Bridgeklubs sæsontider stemmer ikke med klubbens infoside");
  }

  const mondayRows = lines
    .slice(mondayIndex + 1, wednesdayIndex)
    .map((line) => parseRow(line, season, 1, errors))
    .filter((row): row is ScheduleRow => Boolean(row));
  const wednesdayRows = lines
    .slice(wednesdayIndex + 1, weekendIndex)
    .map((line) => parseRow(line, season, 3, errors))
    .filter((row): row is ScheduleRow => Boolean(row));
  const weekendRows = lines
    .slice(weekendIndex + 1, footerIndex)
    .map((line) => parseRow(line, season, "weekend", errors))
    .filter((row): row is ScheduleRow => Boolean(row));
  const rawRowCount = mondayRows.length + wednesdayRows.length + weekendRows.length;
  if (rawRowCount > MAX_ROWS) errors.push(`Ærø Bridgeklub viser flere end ${MAX_ROWS} programlinjer`);
  const mondayDates = mondayRows.flatMap((row) => row.dates);
  if (new Set(mondayDates).size !== mondayDates.length) {
    errors.push("Ærø Bridgeklubs mandagsblokke indeholder overlappende datoer");
  }
  if (!details || !mondayTime || !wednesdayTime || !weekendTime || errors.length > 0) {
    return { candidates: [], excludedSourceEventIds, warnings, errors: [...new Set(errors)], rawRowCount };
  }

  const candidates: NormalizedEventDraft[] = [];
  const mondayKeys = semanticKeys(mondayRows, "Bridge – mandag aften");
  mondayRows.forEach((row, index) => {
    const identity = mondayKeys[index]!;
    if (!identity.title || identity.title.length > 240) {
      errors.push(`Ærø Bridgeklubs mandagsblok ${index + 1} har en ugyldig titel`);
      return;
    }
    const sourceEventId = `season-${season.label}-monday-${identity.key}`;
    const candidate = scheduleCandidate(
      sourceEventId,
      identity.title,
      `Turneringsblok i Ærø Bridgeklubs sæson ${season.startYear}/${String(season.endYear).slice(-2)}: ${row.text}`,
      "MO",
      mondayTime,
      details.mondayDeadline,
      [row],
      details,
      retrievedAt,
      sourceModifiedAt,
      errors,
    );
    if (!candidate) return;
    if (currentAt(row.dates.at(-1)!, mondayTime, now)) {
      candidates.push(candidate);
    } else {
      excludedSourceEventIds.push(sourceEventId);
    }
  });

  const wednesdaySourceEventId = `season-${season.label}-wednesday`;
  const wednesday = scheduleCandidate(
    wednesdaySourceEventId,
    "Bridge – onsdag eftermiddag",
    `Fast onsdagsspil i Ærø Bridgeklubs sæson ${season.startYear}/${String(season.endYear).slice(-2)}.`,
    "WE",
    wednesdayTime,
    details.wednesdayDeadline,
    wednesdayRows,
    details,
    retrievedAt,
    sourceModifiedAt,
    errors,
  );
  if (wednesday) {
    if (currentAt(wednesdayRows.at(-1)!.dates.at(-1)!, wednesdayTime, now)) {
      candidates.push(wednesday);
    } else {
      excludedSourceEventIds.push(wednesdaySourceEventId);
    }
  }

  let historicalWeekendCount = 0;
  const weekendKeys = semanticKeys(
    weekendRows,
    "Weekendbridge",
    (row) => (row.offIsland ? "tur-til-langeland" : undefined),
  );
  weekendRows.forEach((row, index) => {
    const identity = weekendKeys[index]!;
    const sourceEventId = `season-${season.label}-weekend-${identity.key}`;
    const startTime = row.explicitStartTime ?? weekendTime;
    if (!identity.title || identity.title.length > 240) {
      errors.push(`Ærø Bridgeklubs weekendblok ${index + 1} har en ugyldig titel`);
      return;
    }
    if (row.offIsland || !currentAt(row.dates[0]!, startTime, now)) {
      excludedSourceEventIds.push(sourceEventId);
      if (!row.offIsland) historicalWeekendCount += 1;
      return;
    }
    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title: identity.title,
      description: row.text,
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: details.location,
      occurrences: [{
        id: `${sourceEventId}-occurrence-1`,
        date: row.dates[0]!,
        startTime,
        allDay: false,
        timeUnknown: false,
        status: row.status,
      }],
      status: row.status,
      attendance: "unknown",
      attendanceDetails: "Sæsonplanen oplyser ikke gæsteadgang eller tilmelding for weekendaktiviteten.",
      publication: "review",
      reviewReasons: [REVIEW_REASON, "Adgang, tilmelding og sluttid for weekendaktiviteten skal bekræftes"],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: definition.url,
        retrievedAt,
        ...(sourceModifiedAt ? { sourceModifiedAt } : {}),
      },
    });
  });
  if (historicalWeekendCount > 0) {
    warnings.push(`${historicalWeekendCount} passerede weekendaktivitet${historicalWeekendCount === 1 ? "" : "er"} blev udeladt`);
  }
  if (weekendRows.some((row) => row.offIsland)) {
    warnings.push("En tur til Langeland blev udeladt som aktivitet uden for Ærø");
  }
  return {
    candidates: errors.length > 0 ? [] : candidates,
    excludedSourceEventIds,
    warnings,
    errors: [...new Set(errors)],
    rawRowCount,
  };
}

function modifiedInstant(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.fromHTTP(value, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toISO()! : undefined;
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  let pagesFetched = 0;
  try {
    const schedule = await fetchSourceResponse(context, definition.url, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: 100_000,
    });
    pagesFetched += 1;
    const club = await fetchSourceResponse(context, CLUB_DETAILS_URL, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: 100_000,
    });
    pagesFetched += 1;
    const parsed = parseAeroeBridgeklubPages(
      schedule.body,
      club.body,
      retrievedAt,
      context.now,
      modifiedInstant(schedule.headers.get("last-modified")),
    );
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: parsed.errors,
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.candidates.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: parsed.candidates,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds: parsed.excludedSourceEventIds,
      errors: [],
      warnings: parsed.warnings,
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const aeroeBridgeklubSource: SourceAdapter = { definition, collect };
