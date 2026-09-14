import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroeskoebing-grand-prix"];
const GRAND_PRIX_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";

const MONTHS = new Map<string, number>([
  ["januar", 1], ["jan", 1],
  ["februar", 2], ["feb", 2],
  ["marts", 3], ["mar", 3],
  ["april", 4], ["apr", 4],
  ["maj", 5],
  ["juni", 6], ["jun", 6],
  ["juli", 7], ["jul", 7],
  ["august", 8], ["aug", 8],
  ["september", 9], ["sept", 9], ["sep", 9],
  ["oktober", 10], ["okt", 10],
  ["november", 11], ["nov", 11],
  ["december", 12], ["dec", 12],
]);

const WEEKDAYS = new Map<string, number>([
  ["mandag", 1],
  ["tirsdag", 2],
  ["onsdag", 3],
  ["torsdag", 4],
  ["fredag", 5],
  ["lørdag", 6],
  ["søndag", 7],
]);

export interface GrandPrixParseResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

interface ParsedSchedule {
  year: number;
  dates: string[];
  startTime: string;
  endTime: string;
}

function monthNumber(value: string): number | undefined {
  return MONTHS.get(value.toLocaleLowerCase("da-DK").replace(/\.$/, ""));
}

function normalizedClock(hourValue: string, minuteValue: string | undefined): string | undefined {
  const hour = Number(hourValue);
  const minute = minuteValue === undefined ? 0 : Number(minuteValue);
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseSchedule(value: string): { schedule?: ParsedSchedule; errors: string[] } {
  const text = cleanText(value);
  const errors: string[] = [];
  const yearMatch = text.match(/\bDansk\s+Sæbekasse\s+Mesterskab\s*(20\d{2})\b/i);
  if (!yearMatch?.[1]) {
    errors.push("Grand Prix-siden mangler et årstal knyttet til Dansk Sæbekasse Mesterskab");
    return { errors };
  }
  const year = Number(yearMatch[1]);
  const range = text.match(
    /\b(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\s+d(?:en)?\.?\s*(\d{1,2})\.?\s+([a-zæøå]+)\.?\s+til\s+(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\s+d(?:en)?\.?\s*(\d{1,2})\.?\s+([a-zæøå]+)\.?/i,
  );
  if (!range?.[1] || !range[2] || !range[3] || !range[4] || !range[5] || !range[6]) {
    errors.push("Grand Prix-siden mangler det forventede eksplicitte datointerval");
    return { errors };
  }
  const startMonth = monthNumber(range[3]);
  const endMonth = monthNumber(range[6]);
  if (!startMonth || !endMonth) {
    errors.push("Grand Prix-sidens datointerval har et ukendt månedsnavn");
    return { errors };
  }
  const start = DateTime.fromObject(
    { year, month: startMonth, day: Number(range[2]) },
    { zone: COPENHAGEN },
  );
  const endYear = endMonth < startMonth ? year + 1 : year;
  const end = DateTime.fromObject(
    { year: endYear, month: endMonth, day: Number(range[5]) },
    { zone: COPENHAGEN },
  );
  if (!start.isValid || !end.isValid || end < start) {
    errors.push("Grand Prix-sidens datointerval er ugyldigt");
    return { errors };
  }
  const spanDays = end.diff(start, "days").days;
  if (!Number.isInteger(spanDays) || spanDays > 14) {
    errors.push("Grand Prix-sidens aktivitetsinterval er uventet langt");
    return { errors };
  }
  if (WEEKDAYS.get(range[1].toLocaleLowerCase("da-DK")) !== start.weekday) {
    errors.push("Grand Prix-sidens startdato stemmer ikke med det angivne ugedagsnavn");
  }
  if (WEEKDAYS.get(range[4].toLocaleLowerCase("da-DK")) !== end.weekday) {
    errors.push("Grand Prix-sidens slutdato stemmer ikke med det angivne ugedagsnavn");
  }

  const timeMatch = text.match(
    /(?:fra\s+)?kl\.?\s*(\d{1,2})(?:[.:](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?/i,
  );
  const startTime = timeMatch?.[1]
    ? normalizedClock(timeMatch[1], timeMatch[2])
    : undefined;
  const endTime = timeMatch?.[3]
    ? normalizedClock(timeMatch[3], timeMatch[4])
    : undefined;
  if (!startTime || !endTime || endTime <= startTime) {
    errors.push("Grand Prix-siden mangler et gyldigt start- og sluttidspunkt");
    return { errors };
  }
  if (errors.length > 0) return { errors };

  const dates = Array.from(
    { length: spanDays + 1 },
    (_unused, index) => start.plus({ days: index }).toISODate()!,
  );
  return { schedule: { year, dates, startTime, endTime }, errors };
}

function eventStatus(value: string): EventStatus {
  if (/\baflyst\b/i.test(value)) return "cancelled";
  if (/\b(?:udsat|udskudt|flyttet)\b/i.test(value)) return "postponed";
  return "scheduled";
}

function secureBookingUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined;
  const resolved = new URL(value, pageUrl);
  return resolved.protocol === "https:" ? resolved.toString() : undefined;
}

export function parseAeroeskoebingGrandPrixPage(
  html: string,
  retrievedAt: string,
  pageUrl = definition.url,
): GrandPrixParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const title = cleanText($("title").first().text());
  if (!/Ærøskøbing\s*grand\s*prix/i.test(title)) {
    errors.push("Grand Prix-siden mangler den forventede sidetitel");
  }
  const headingMatches = $(".wixui-rich-text h1").filter((_index, element) =>
    /Ærøskøbing\s+Grand\s+Prix/i.test(cleanText($(element).text()))
  );
  if (headingMatches.length !== 1) {
    errors.push("Grand Prix-siden mangler den entydige Ærøskøbing Grand Prix-overskrift");
  }

  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  let canonicalUrl: string | undefined;
  try {
    canonicalUrl = canonicalHref
      ? sameOriginHttpsUrl(absoluteUrl(canonicalHref, pageUrl), GRAND_PRIX_ORIGIN)
      : undefined;
  } catch (error) {
    errors.push(`Grand Prix-sidens canonical-link er usikkert: ${errorMessage(error)}`);
  }
  if (
    !canonicalUrl ||
    new URL(canonicalUrl).origin !== GRAND_PRIX_ORIGIN ||
    new URL(canonicalUrl).pathname.replace(/\/+$/, "") !== ""
  ) {
    errors.push("Grand Prix-sidens canonical-link peger ikke på den forventede forside");
  }

  const scheduleTexts = $(".wixui-rich-text").map((_index, element) =>
    cleanText($(element).text())
  ).get().filter((value) => /Dansk\s+Sæbekasse\s+Mesterskab/i.test(value));
  const uniqueScheduleTexts = [...new Set(scheduleTexts)];
  if (uniqueScheduleTexts.length !== 1) {
    errors.push(
      uniqueScheduleTexts.length === 0
        ? "Grand Prix-siden mangler programblokken for Dansk Sæbekasse Mesterskab"
        : "Grand Prix-siden indeholder modstridende programblokke",
    );
  } else if (scheduleTexts.length > 1) {
    warnings.push("Wix-siden gengav den samme Grand Prix-programblok flere gange");
  }

  const now = DateTime.fromISO(retrievedAt, { setZone: true }).setZone(COPENHAGEN);
  if (!now.isValid) errors.push("Indsamlingstidspunktet for Grand Prix er ugyldigt");
  const parsed = uniqueScheduleTexts[0]
    ? parseSchedule(uniqueScheduleTexts[0])
    : { errors: [] as string[] };
  errors.push(...parsed.errors);
  if (errors.length > 0 || !canonicalUrl || !parsed.schedule || !now.isValid) {
    return { warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
  }

  const bookingLinks: string[] = [];
  for (const element of $("a[href]").filter((_index, anchor) =>
    /^tilmelding$/i.test(cleanText($(anchor).text()))
  ).toArray()) {
    const href = $(element).attr("href");
    try {
      const bookingUrl = secureBookingUrl(href, pageUrl);
      if (bookingUrl) bookingLinks.push(bookingUrl);
      else warnings.push("Grand Prix-sidens tilmeldingslink bruger ikke HTTPS");
    } catch {
      warnings.push("Grand Prix-sidens tilmeldingslink er ugyldigt");
    }
  }
  const uniqueBookingLinks = [...new Set(bookingLinks)];
  if (uniqueBookingLinks.length > 1) {
    errors.push("Grand Prix-siden indeholder flere forskellige tilmeldingslinks");
  }
  const bookingUrl = uniqueBookingLinks[0];

  const status = eventStatus(uniqueScheduleTexts[0]!);
  const futureDates = parsed.schedule.dates.filter((date) => {
    const end = DateTime.fromISO(`${date}T${parsed.schedule!.endTime}`, { zone: COPENHAGEN });
    return end.isValid && end >= now;
  });
  if (futureDates.length !== parsed.schedule.dates.length) {
    warnings.push("Historiske aktivitetsdage fra Grand Prix-programmet blev udeladt");
  }
  if (errors.length > 0 || futureDates.length === 0) {
    if (futureDates.length === 0) {
      errors.push("Grand Prix-programmet indeholder ingen kommende aktivitetsdage");
    }
    return { warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
  }

  const sourceEventId = `${definition.organizerId}-${parsed.schedule.year}`;
  const reviewReasons = [
    "Årets program står som fri tekst på en Wix-side uden et selvstændigt eventobjekt.",
    "Kontrollér eventuelt overlap med VisitÆrøs GuideDanmark-post før publicering.",
    "Forsiden oplyser ikke et præcist mødested.",
  ];
  if (!bookingUrl) {
    reviewReasons.push("Forsiden indeholder ikke et sikkert tilmeldingslink.");
  }
  const candidate: NormalizedEventDraft = {
    sourceId: definition.id,
    sourceEventId,
    stableId: sourceEventId,
    title: `Ærøskøbing Grand Prix ${parsed.schedule.year}`,
    description: uniqueScheduleTexts[0]!,
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: { city: "Ærøskøbing" },
    occurrences: futureDates.map((date) => ({
      id: `${sourceEventId}-${date.slice(5)}`,
      date,
      startTime: parsed.schedule!.startTime,
      endTime: parsed.schedule!.endTime,
      allDay: false,
      timeUnknown: false,
      status,
    })),
    status,
    availability: "unknown",
    attendance: bookingUrl ? "registration" : "unknown",
    ...(bookingUrl
      ? {
          attendanceDetails: "Tilmelding via arrangørens hjemmeside.",
          bookingUrl,
          bookingRequired: true,
          bookingDetails: "Tilmeldingsside er linket fra kildens hovedmenu.",
        }
      : {}),
    publication: "review",
    reviewReasons,
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl: canonicalUrl,
      retrievedAt,
    },
  };
  return { candidate, warnings: [...new Set(warnings)], errors: [] };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: GRAND_PRIX_ORIGIN,
    });
    const parsed = parseAeroeskoebingGrandPrixPage(html, retrievedAt, definition.url);
    if (parsed.errors.length > 0 || !parsed.candidate) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: parsed.errors.length > 0
          ? parsed.errors
          : ["Grand Prix-siden returnerede ingen kommende event; snapshot beholdes"],
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.candidate ? 1 : 0,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: [parsed.candidate],
      errors: [],
      warnings: parsed.warnings,
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

export const aeroeskoebingGrandPrixSource: SourceAdapter = { definition, collect };
