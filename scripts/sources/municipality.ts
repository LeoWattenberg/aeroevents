import { load } from "cheerio";
import { DateTime } from "luxon";

import {
  errorMessage,
  fetchJson,
  fetchSourceResponse,
  fetchText,
} from "./http";
import { cleanText, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-kommune"];
const MUNICIPALITY_ORIGIN = new URL(definition.url).origin;
const FIRSTAGENDA_URL = "https://dagsordener.aeroekommune.dk/";
const FIRSTAGENDA_ORIGIN = new URL(FIRSTAGENDA_URL).origin;
const FIRSTAGENDA_COMMITTEES_URL = new URL(
  "/api/agenda/udvalgsliste",
  FIRSTAGENDA_URL,
).toString();
const COPENHAGEN = "Europe/Copenhagen";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  ["sep", 9],
  ["oktober", 10],
  ["okt", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

export interface MunicipalityParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

export interface FirstAgendaMeeting {
  id: string;
  date: string;
  startTime: string;
  endDate?: string;
  endTime?: string;
  location?: string;
  releasedAt?: string;
}

export interface FirstAgendaParseResult {
  meetings: FirstAgendaMeeting[];
  warnings: string[];
  errors: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function localDateTime(value: unknown): DateTime | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true }).setZone(COPENHAGEN);
  return parsed.isValid ? parsed : undefined;
}

/** Parse only the current, public Kommunalbestyrelsen committee. */
export function parseFirstAgendaMeetings(value: unknown): FirstAgendaParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const meetings: FirstAgendaMeeting[] = [];
  const root = record(value);
  const groups = record(root?.Udvalg);
  if (!groups) {
    return {
      meetings,
      warnings,
      errors: ["FirstAgenda-svaret mangler udvalgsgrupper"],
    };
  }

  const currentGroups = Object.entries(groups).filter(([name, committees]) =>
    /^aktuelle politiske\b/i.test(cleanText(name)) && Array.isArray(committees),
  );
  if (currentGroups.length !== 1) {
    errors.push(
      currentGroups.length === 0
        ? "FirstAgenda-svaret mangler gruppen med aktuelle politiske udvalg"
        : "FirstAgenda-svaret har flere grupper med aktuelle politiske udvalg",
    );
    return { meetings, warnings, errors };
  }

  const committees = currentGroups[0]?.[1] as unknown[];
  const municipalityCommittees = committees.filter((candidate) => {
    const item = record(candidate);
    return typeof item?.Navn === "string" && cleanText(item.Navn) === "Kommunalbestyrelsen";
  });
  if (municipalityCommittees.length !== 1) {
    errors.push(
      municipalityCommittees.length === 0
        ? "FirstAgenda-svaret mangler det aktuelle Kommunalbestyrelsen"
        : "FirstAgenda-svaret har flere aktuelle Kommunalbestyrelser",
    );
    return { meetings, warnings, errors };
  }

  const rawMeetings = record(municipalityCommittees[0])?.Moeder;
  if (!Array.isArray(rawMeetings)) {
    errors.push("FirstAgenda-svaret mangler Kommunalbestyrelsens mødeliste");
    return { meetings, warnings, errors };
  }

  for (const [index, value] of rawMeetings.entries()) {
    const item = record(value);
    if (!item) {
      errors.push(`FirstAgenda-møde ${index + 1} er ikke et objekt`);
      continue;
    }
    if (item.IsSupplementaryAgenda === true) continue;
    const id = typeof item.Id === "string" ? item.Id.toLowerCase() : "";
    const start = localDateTime(item.MeetingBeginUtc ?? item.Dato);
    const end = item.MeetingEndUtc == null ? undefined : localDateTime(item.MeetingEndUtc);
    if (!GUID.test(id) || !start || (item.MeetingEndUtc != null && !end)) {
      errors.push(`FirstAgenda-møde ${index + 1} mangler gyldigt GUID eller tidspunkt`);
      continue;
    }
    if (end && end < start) {
      errors.push(`FirstAgenda-møde ${id} slutter før det starter`);
      continue;
    }
    const released = item.ReleasedDate == null ? undefined : localDateTime(item.ReleasedDate);
    if (item.ReleasedDate != null && !released) {
      warnings.push(`FirstAgenda-møde ${id} har et ugyldigt publiceringstidspunkt`);
    }
    const location = typeof item.Sted === "string" ? cleanText(item.Sted) : "";
    meetings.push({
      id,
      date: start.toISODate()!,
      startTime: start.toFormat("HH:mm"),
      ...(end ? { endDate: end.toISODate()!, endTime: end.toFormat("HH:mm") } : {}),
      ...(location ? { location } : {}),
      ...(released ? { releasedAt: released.toISO()! } : {}),
    });
  }

  const ids = meetings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    errors.push("FirstAgenda-svaret indeholder det samme møde-GUID flere gange");
  }
  return { meetings, warnings, errors };
}

function dateDistanceDays(left: string, right: string): number {
  return Math.abs(
    DateTime.fromISO(left, { zone: COPENHAGEN }).startOf("day").diff(
      DateTime.fromISO(right, { zone: COPENHAGEN }).startOf("day"),
      "days",
    ).days,
  );
}

function agendaOccurrence(meeting: FirstAgendaMeeting): ExplicitOccurrenceDraft {
  return {
    id: `firstagenda-${meeting.id}`,
    date: meeting.date,
    startTime: meeting.startTime,
    ...(meeting.endDate ? { endDate: meeting.endDate } : {}),
    ...(meeting.endTime ? { endTime: meeting.endTime } : {}),
    allDay: false,
    timeUnknown: false,
    ...(meeting.location ? { location: { name: meeting.location } } : {}),
  };
}

/** Merge released agendas into the long-range annual plan without creating a second event. */
export function enrichMunicipalityCandidates(
  candidates: NormalizedEventDraft[],
  meetings: FirstAgendaMeeting[],
): string[] {
  const warnings: string[] = [];
  for (const candidate of candidates) {
    const year = Number(candidate.sourceEventId.match(/-(20\d{2})$/)?.[1]);
    if (!Number.isInteger(year)) continue;
    const yearMeetings = meetings
      .filter((meeting) => Number(meeting.date.slice(0, 4)) === year)
      .sort((left, right) =>
        `${left.date}T${left.startTime}`.localeCompare(`${right.date}T${right.startTime}`),
      );
    if (yearMeetings.length === 0) continue;

    const original = [...candidate.occurrences];
    const usedOriginal = new Set<number>();
    const replacements = new Map<number, FirstAgendaMeeting>();
    const unmatched: FirstAgendaMeeting[] = [];

    // Exact dates are unambiguous and must win before moved/extra meetings are considered.
    for (const meeting of yearMeetings) {
      const exactIndex = original.findIndex(
        (occurrence, index) => !usedOriginal.has(index) && occurrence.date === meeting.date,
      );
      if (exactIndex >= 0) {
        usedOriginal.add(exactIndex);
        replacements.set(exactIndex, meeting);
      } else {
        unmatched.push(meeting);
      }
    }

    const extras: FirstAgendaMeeting[] = [];
    for (const meeting of unmatched) {
      const movable = original
        .map((occurrence, index) => ({ occurrence, index }))
        .filter(({ occurrence, index }) =>
          !usedOriginal.has(index) &&
          occurrence.startTime === meeting.startTime &&
          dateDistanceDays(occurrence.date, meeting.date) <= 14,
        )
        .sort(
          (left, right) =>
            dateDistanceDays(left.occurrence.date, meeting.date) -
              dateDistanceDays(right.occurrence.date, meeting.date) ||
            left.index - right.index,
        )[0];
      if (movable) {
        usedOriginal.add(movable.index);
        replacements.set(movable.index, meeting);
        warnings.push(
          `FirstAgenda flyttede Kommunalbestyrelsesmødet ${movable.occurrence.date} til ${meeting.date}`,
        );
      } else {
        extras.push(meeting);
      }
    }

    candidate.occurrences = [
      ...original.map((occurrence, index) => {
        const replacement = replacements.get(index);
        return replacement ? agendaOccurrence(replacement) : occurrence;
      }),
      ...extras.map(agendaOccurrence),
    ].sort((left, right) =>
      `${left.date}T${left.startTime ?? ""}`.localeCompare(
        `${right.date}T${right.startTime ?? ""}`,
      ) || left.id.localeCompare(right.id),
    );

    const modifiedAt = yearMeetings
      .map(({ releasedAt }) => releasedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    if (modifiedAt) candidate.provenance.sourceModifiedAt = modifiedAt;
  }
  return warnings;
}

function cookieHeader(setCookies: string[]): string | undefined {
  const pairs = setCookies
    .map((cookie) => cookie.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([^;\r\n]*)/)?.slice(1))
    .filter((value): value is [string, string] => Boolean(value))
    .map(([name, value]) => `${name}=${value}`);
  return pairs.length > 0 ? [...new Set(pairs)].join("; ") : undefined;
}

function parseMonth(header: string): number | undefined {
  return MONTHS.get(
    cleanText(header).toLocaleLowerCase("da-DK").replace(/\.$/, ""),
  );
}

function parseMeetingTime(text: string): string | undefined {
  const match = text.match(
    /m[øo]detidspunkt(?:et)?(?:\s+er)?\s*(?:kl\.?\s*)?(\d{1,2})[.:](\d{2})/i,
  );
  if (!match?.[1] || !match[2]) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseMunicipalityPage(
  html: string,
  retrievedAt: string,
): MunicipalityParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];

  const sections = $("bui-accordion-item").filter((_index, element) => {
    const heading = cleanText($(element).find("[slot='heading']").first().text());
    return heading.toLocaleLowerCase("da-DK") === "kommunalbestyrelsen";
  });

  if (sections.length !== 1) {
    errors.push(
      sections.length === 0
        ? "Fandt ikke Kommunalbestyrelsen-sektionen"
        : "Fandt flere Kommunalbestyrelsen-sektioner end forventet",
    );
    return { candidates, warnings, errors };
  }

  const section = sections.first();
  const sectionText = cleanText(section.text());
  const startTime = parseMeetingTime(sectionText);
  if (!startTime) {
    errors.push("Kommunalbestyrelsens mødetidspunkt mangler eller er ugyldigt");
  }

  const tables = section.find("table");
  if (tables.length === 0) {
    errors.push("Kommunalbestyrelsens mødetabel mangler");
  }

  tables.each((_tableIndex, tableElement) => {
    const table = $(tableElement);
    const yearText = `${table.find("caption").text()} ${section.closest("bui-accordion").find("[slot='heading']").first().text()}`;
    const yearMatch = yearText.match(/\b(20\d{2})\b/);
    if (!yearMatch?.[1]) {
      errors.push("Kunne ikke bestemme årstal for Kommunalbestyrelsens mødetabel");
      return;
    }
    const year = Number(yearMatch[1]);

    const headers = table
      .find("thead tr").first().find("th")
      .map((_index, element) => cleanText($(element).text()))
      .get();
    const fallbackHeaders = table
      .find("tr").first().find("th")
      .map((_index, element) => cleanText($(element).text()))
      .get();
    const monthHeaders = headers.length > 0 ? headers : fallbackHeaders;
    const months = monthHeaders.map(parseMonth);

    if (months.length !== 12 || months.some((month) => month === undefined)) {
      errors.push(`Månedskolonnerne for ${year} kunne ikke aflæses sikkert`);
      return;
    }

    const dataRows = table.find("tbody tr").filter((_index, element) =>
      $(element).find("td").length > 0,
    );
    if (dataRows.length !== 1) {
      errors.push(`Forventede én datarække i mødetabellen for ${year}`);
      return;
    }

    const occurrences: ExplicitOccurrenceDraft[] = [];
    dataRows.first().find("td").each((columnIndex, cellElement) => {
      const month = months[columnIndex];
      if (month === undefined) return;
      const cell = cleanText($(cellElement).text());
      if (!cell || /^[-–—]$/.test(cell)) return;

      const days = [...cell.matchAll(/(?:^|[^\d])(\d{1,2})\s*\./g)].map(
        (match) => Number(match[1]),
      );
      if (days.length === 0) {
        errors.push(`Kunne ikke aflæse mødedatoen i ${month}/${year}: “${cell}”`);
        return;
      }
      if (cell.includes("*")) {
        warnings.push(`Kommunen har markeret en mulig tidsændring i ${month}/${year}`);
      }

      days.forEach((day, occurrenceIndex) => {
        if (!validCalendarDate(year, month, day)) {
          errors.push(`Ugyldig mødedato: ${day}/${month}/${year}`);
          return;
        }
        occurrences.push({
          id: `kommunalbestyrelsen-${year}-${String(month).padStart(2, "0")}-${occurrenceIndex + 1}`,
          date: isoDate(year, month, day),
          ...(startTime ? { startTime } : {}),
          allDay: false,
          timeUnknown: startTime === undefined,
        });
      });
    });

    if (occurrences.length === 0) {
      errors.push(`Mødetabellen for ${year} indeholder ingen gyldige datoer`);
      return;
    }

    const sourceEventId = `kommunalbestyrelsen-${year}`;
    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title: `Kommunalbestyrelsesmøder ${year}`,
      description: "Offentligt annoncerede møder i Kommunalbestyrelsen på Ærø.",
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      occurrences,
      status: "scheduled",
      attendance: "public",
      publication: warnings.length > 0 ? "review" : "trusted",
      reviewReasons: warnings.length > 0 ? [...warnings] : [],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: definition.url,
        retrievedAt,
      },
    });
  });

  return { candidates, warnings, errors };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, {
      expectedOrigin: MUNICIPALITY_ORIGIN,
    });
    const parsed = parseMunicipalityPage(html, retrievedAt);
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: parsed.errors,
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.candidates.length,
      };
    }

    let pagesFetched = 1;
    try {
      const bootstrap = await fetchSourceResponse(context, FIRSTAGENDA_URL, {
        expectedOrigin: FIRSTAGENDA_ORIGIN,
      });
      pagesFetched += 1;
      const cookie = cookieHeader(bootstrap.setCookies);
      if (!cookie) throw new Error("FirstAgenda returnerede ingen anonym sessionscookie");
      const agendaValue = await fetchJson(context, FIRSTAGENDA_COMMITTEES_URL, {
        expectedOrigin: FIRSTAGENDA_ORIGIN,
        headers: { cookie },
      });
      pagesFetched += 1;
      const agenda = parseFirstAgendaMeetings(agendaValue);
      parsed.warnings.push(...agenda.warnings);
      if (agenda.errors.length > 0) {
        parsed.warnings.push(
          `FirstAgenda kunne ikke bruges: ${agenda.errors.join("; ")}`,
        );
      } else {
        parsed.warnings.push(
          ...enrichMunicipalityCandidates(parsed.candidates, agenda.meetings),
        );
      }
    } catch (error) {
      // The annual plan is a complete source by itself. Agenda publication is
      // deliberately best-effort so a short outage cannot erase future dates.
      parsed.warnings.push(`FirstAgenda-berigelse blev sprunget over: ${errorMessage(error)}`);
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: parsed.candidates,
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

export const municipalitySource: SourceAdapter = { definition, collect };
