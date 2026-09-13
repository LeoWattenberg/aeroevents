import { load } from "cheerio";

import { errorMessage, fetchText } from "./http";
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
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
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
