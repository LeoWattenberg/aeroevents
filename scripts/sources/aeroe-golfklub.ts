import { createHash } from "node:crypto";

import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText, deduplicateBy, isoDate, slug, validCalendarDate } from "./html";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-golfklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const GOLFBOX_URL = "https://golfbox.golf/#/";
const MAX_EVENTS = 50;
const DATE_LINE = /^(?:(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:\s+og\s+(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag))?\s+)?(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*\/\s*(\d{1,2})\s*:\s*(.+)$/iu;
const DATEISH_LINE = /^(?:(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b|\d{1,2}\s*(?:[-–]\s*\d{1,2})?\s*(?:\/|\.))/iu;

export interface AeroeGolfklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  declaredYear?: number;
  rawEventCount: number;
}

function linesFromParagraph(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
): string[] {
  const clone = $(element).clone();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function datesForRange(
  eventKey: string,
  year: number,
  firstDay: number,
  lastDay: number | undefined,
  month: number,
): ExplicitOccurrenceDraft[] | undefined {
  const end = lastDay ?? firstDay;
  if (
    end < firstDay ||
    end - firstDay > 7 ||
    !validCalendarDate(year, month, firstDay) ||
    !validCalendarDate(year, month, end)
  ) {
    return undefined;
  }
  const eventDigest = createHash("sha256").update(eventKey, "utf8").digest("hex").slice(0, 20);
  return Array.from({ length: end - firstDay + 1 }, (_value, offset) => {
    const date = isoDate(year, month, firstDay + offset);
    return {
      id: `golf-${eventDigest}-day-${offset + 1}`,
      date,
      allDay: false,
      timeUnknown: true,
    };
  });
}

export function parseAeroeGolfklubPage(
  html: string,
  retrievedAt: string,
): AeroeGolfklubParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];

  const canonical = $("link[rel='canonical']").attr("href");
  if (canonical) {
    try {
      const safe = sameOriginHttpsUrl(canonical, SOURCE_ORIGIN);
      if (new URL(safe).pathname.toLowerCase() !== "/turneringer.aspx") {
        errors.push("Ærø Golf Klubs canonical-link matcher ikke turneringssiden");
      }
    } catch {
      errors.push("Ærø Golf Klubs canonical-link er usikkert");
    }
  }
  if (!/Golfturneringer på Ærø|Ærø Golf/iu.test(cleanText($("title").text()))) {
    errors.push("Turneringssiden kan ikke identificeres som Ærø Golf Klubs side");
  }

  const headings = $("h2").filter((_index, element) =>
    /\b\d{4}\s+turneringskalender\b/iu.test(cleanText($(element).text())),
  );
  if (headings.length !== 1) {
    errors.push("Ærø Golf Klubs årsoverskrift for turneringskalenderen mangler");
    return { candidates: [], warnings, errors, rawEventCount: 0 };
  }
  const headingText = cleanText(headings.first().text());
  const yearMatch = headingText.match(/\b(20\d{2})\b/);
  const declaredYear = yearMatch?.[1] ? Number(yearMatch[1]) : undefined;
  if (!declaredYear) {
    errors.push("Ærø Golf Klubs turneringsår er ugyldigt");
    return { candidates: [], warnings, errors, rawEventCount: 0 };
  }

  const rows: Array<{ firstDay: number; lastDay?: number; month: number; text: string }> = [];
  let reachedContact = false;
  headings.first().nextAll("p").each((_index, element) => {
    if (reachedContact) return;
    for (const line of linesFromParagraph($, element)) {
      if (/^Turneringsformand\b/iu.test(line)) {
        reachedContact = true;
        break;
      }
      const match = line.match(DATE_LINE);
      if (!match?.[1] || !match[3] || !match[4]) {
        if (DATEISH_LINE.test(line)) {
          errors.push("Ærø Golf Klubs turneringskalender indeholder en dateret linje i et ukendt format");
        }
        continue;
      }
      rows.push({
        firstDay: Number(match[1]),
        ...(match[2] ? { lastDay: Number(match[2]) } : {}),
        month: Number(match[3]),
        text: cleanText(match[4]),
      });
    }
  });
  if (rows.length === 0) errors.push("Ærø Golf Klubs turneringskalender indeholder ingen daterede poster");
  if (rows.length > MAX_EVENTS) errors.push(`Ærø Golf Klub viser flere end ${MAX_EVENTS} turneringer`);

  const candidates: NormalizedEventDraft[] = [];
  rows.forEach((row, index) => {
    const open = /(?:^|\/)\s*åben\s+turnering\b/iu.test(row.text);
    const title = cleanText(
      row.text
        .replace(/\s*\/\s*åben\s+turnering\s*\.?$/iu, "")
        .replace(/[\s.]+$/g, ""),
    );
    const titleSlug = slug(title);
    if (!title || !titleSlug || title.length > 240) {
      errors.push(`Golfturnering ${index + 1} mangler en gyldig titel`);
      return;
    }
    const sourceEventId = `${declaredYear}-${titleSlug}`;
    const occurrences = datesForRange(
      sourceEventId,
      declaredYear,
      row.firstDay,
      row.lastDay,
      row.month,
    );
    if (!occurrences) {
      errors.push(`Golfturnering ${sourceEventId} har et ugyldigt datointerval`);
      return;
    }
    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title,
      description: open
        ? "Åben turnering. Deltagelse kræver DGU-kort; se GolfBox for turneringsform og vilkår."
        : "Klubturnering for medlemmer; se GolfBox for turneringsform og vilkår.",
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: {
        name: "Ærø Golf Klub",
        address: "Skjoldnæsvej 8",
        postalCode: "5985",
        city: "Søby Ærø",
      },
      occurrences,
      status: "scheduled",
      attendance: open ? "registration" : "members",
      attendanceDetails: open
        ? "Åben for medlemmer og gæster med DGU-kort."
        : "Klubmesterskabet er kun for medlemmer.",
      price: open
        ? "Turneringsfee ca. 100 kr. for medlemmer; gæstespillere betaler 250 kr. i greenfee."
        : "Turneringsfee ca. 100 kr.",
      bookingUrl: GOLFBOX_URL,
      bookingRequired: true,
      bookingDetails: "Tilmelding åbner ifølge klubben 10 dage før turneringsdatoen.",
      publication: "review",
      reviewReasons: ["Kilden angiver ikke turneringernes starttid; dato og adgang skal kontrolleres før publicering."],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: definition.url,
        retrievedAt,
      },
    });
  });

  const unique = deduplicateBy(candidates, (candidate) => candidate.sourceEventId);
  if (unique.length !== candidates.length) {
    errors.push("Ærø Golf Klubs kalender indeholder dublerede turneringstitler i samme sæson");
  }
  return {
    candidates: unique,
    warnings,
    errors,
    declaredYear,
    rawEventCount: rows.length,
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseAeroeGolfklubPage(html, retrievedAt);
    const today = DateTime.fromJSDate(context.now).setZone(COPENHAGEN).startOf("day");
    const rangeEnd = today.plus({ months: 12 });
    const current = parsed.candidates
      .map((candidate) => ({
        ...candidate,
        occurrences: candidate.occurrences.filter((occurrence) => {
          const date = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN });
          return date >= today && date <= rangeEnd;
        }),
      }))
      .filter((candidate) => candidate.occurrences.length > 0);
    const currentIds = new Set(current.map((candidate) => candidate.sourceEventId));
    const excludedSourceEventIds = parsed.candidates
      .map((candidate) => candidate.sourceEventId)
      .filter((sourceEventId) => !currentIds.has(sourceEventId));
    const errors = [...parsed.errors];
    if (current.length === 0 && parsed.rawEventCount > 0) {
      errors.push("Ærø Golf Klub har ingen turneringer i indsamlingsvinduet");
    }
    if (errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: [...new Set(errors)],
        warnings: parsed.warnings,
        discardedCandidateCount: current.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: current,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds,
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

export const aeroeGolfklubSource: SourceAdapter = { definition, collect };
