import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["marstal-if"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const MAX_MATCHES = 500;
const MAX_MATCH_ID_LENGTH = 20;
const MAX_TEAM_NAME_LENGTH = 110;
const MAX_STADIUM_LENGTH = 200;
const MAX_COMPETITION_LENGTH = 10_000;

const DANISH_MONTHS: Record<string, number> = {
  januar: 1,
  februar: 2,
  marts: 3,
  april: 4,
  maj: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  december: 12,
};

const DANISH_WEEKDAYS: Record<string, number> = {
  mandag: 1,
  tirsdag: 2,
  onsdag: 3,
  torsdag: 4,
  fredag: 5,
  "lørdag": 6,
  "søndag": 7,
};

interface MonthHeading {
  month: number;
  year: number;
}

interface MatchIdentity {
  matchId: string;
  poolRowId: string;
  sourceUrl: string;
}

export interface MarstalIfParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  excludedSourceEventIds: string[];
}

function parseMonthHeading(value: string): MonthHeading | undefined {
  const match = cleanText(value).toLocaleLowerCase("da-DK").match(/^([a-zæøå]+)\s+(20\d{2})$/u);
  const month = match?.[1] ? DANISH_MONTHS[match[1]] : undefined;
  const year = match?.[2] ? Number(match[2]) : undefined;
  return month && year ? { month, year } : undefined;
}

function parseTime(value: string): string | undefined {
  const match = cleanText(value).match(/^([01]?\d|2[0-3])[.:]([0-5]\d)$/);
  return match?.[1] && match[2] ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

function parseIdentity(value: string | undefined): MatchIdentity | undefined {
  if (!value) return undefined;
  const sourceUrl = sameOriginHttpsUrl(value, definition.url);
  const url = new URL(sourceUrl);
  const matchIds = url.searchParams.getAll("matchid");
  const poolRowIds = url.searchParams.getAll("poolrowid");
  if (
    url.pathname.replace(/\/+$/, "") !== "/kampvisning" ||
    matchIds.length !== 1 ||
    poolRowIds.length !== 1 ||
    !new RegExp(`^[1-9]\\d{0,${MAX_MATCH_ID_LENGTH - 1}}$`, "u").test(matchIds[0] ?? "") ||
    !new RegExp(`^[1-9]\\d{0,${MAX_MATCH_ID_LENGTH - 1}}$`, "u").test(poolRowIds[0] ?? "")
  ) {
    return undefined;
  }
  return {
    matchId: matchIds[0]!,
    poolRowId: poolRowIds[0]!,
    sourceUrl,
  };
}

function statusFromRow(value: string, className: string): EventStatus {
  const evidence = `${className} ${value}`;
  if (/\b(?:aflyst|annulleret|cancelled|canceled)\b/iu.test(evidence)) return "cancelled";
  if (/\b(?:udsat|udskudt|flyttet|postponed)\b/iu.test(evidence)) return "postponed";
  return "scheduled";
}

function isMarstalHomeTeam(value: string): boolean {
  const normalized = cleanText(value).toLocaleLowerCase("da-DK");
  return normalized === "marstal if" || normalized === "marstal/rise";
}

function isMarstalStadium(value: string): boolean {
  const normalized = cleanText(value).toLocaleLowerCase("da-DK");
  return /\bmarstal\b/u.test(normalized) && /\bstadion\b/u.test(normalized);
}

function uniqueText(
  values: string[],
  label: string,
  identity: string,
  errors: string[],
): string | undefined {
  const normalized = [...new Set(values.map(cleanText).filter(Boolean))];
  if (normalized.length !== 1) {
    errors.push(`Marstal IF-kamp ${identity} har ${normalized.length} entydige ${label}`);
    return undefined;
  }
  return normalized[0];
}

export function parseMarstalIfPage(
  html: string,
  retrievedAt: string,
  now: Date,
): MarstalIfParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];

  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  try {
    const canonical = canonicalHref
      ? new URL(sameOriginHttpsUrl(canonicalHref, definition.url))
      : undefined;
    const expected = new URL(definition.url);
    if (
      !canonical ||
      canonical.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "") ||
      canonical.search ||
      canonical.hash
    ) {
      errors.push("Marstal IF-sidens canonical-link matcher ikke siden med kommende kampe");
    }
  } catch (error) {
    errors.push(`Marstal IF-sidens canonical-link er usikkert: ${errorMessage(error)}`);
  }

  const author = cleanText($("meta[name='author']").first().attr("content") ?? "");
  if (author !== "Marstal IF") errors.push("Marstal IF-sidens kildeidentitet mangler");

  const roots = $(".theme_ClubFixtures").filter((_index, element) =>
    cleanText($(element).children(".theme_header").first().text()) === "Alle Kampe"
  );
  if (roots.length !== 1) {
    errors.push(`Marstal IF-siden indeholder ${roots.length} entydige kampprogrammer`);
    return { candidates: [], warnings, errors, excludedSourceEventIds: [] };
  }

  const rows = roots.first().find("tr.match");
  if (rows.length === 0) {
    errors.push("Marstal IF-siden indeholder ingen kamprækker");
    return { candidates: [], warnings, errors, excludedSourceEventIds: [] };
  }
  if (rows.length > MAX_MATCHES) {
    errors.push(`Marstal IF-siden indeholder flere end ${MAX_MATCHES} kampe`);
    return { candidates: [], warnings, errors, excludedSourceEventIds: [] };
  }

  const today = DateTime.fromJSDate(now, { zone: COPENHAGEN }).startOf("day");
  if (!today.isValid) {
    return {
      candidates: [],
      warnings,
      errors: ["Indsamlingstidspunktet er ugyldigt"],
      excludedSourceEventIds: [],
    };
  }

  const candidates: NormalizedEventDraft[] = [];
  const identities = new Set<string>();
  const excludedSourceEventIds = new Set<string>();
  let currentMonth: MonthHeading | undefined;
  let awayCount = 0;
  let pastCount = 0;
  let nonLocalCount = 0;

  roots.first().find("tr.monthRow, tr.match").each((rowIndex, element) => {
    const row = $(element);
    if (row.hasClass("monthRow")) {
      const parsed = parseMonthHeading(row.find(".theme_ClubFixtures_monthBar").first().text());
      if (!parsed) errors.push(`Marstal IF-kalenderens månedsoverskrift ${rowIndex + 1} er ugyldig`);
      currentMonth = parsed;
      return;
    }

    let identity: MatchIdentity | undefined;
    try {
      identity = parseIdentity(row.attr("data-url"));
    } catch (error) {
      errors.push(`Marstal IF-kamprække ${rowIndex + 1} har et usikkert link: ${errorMessage(error)}`);
      return;
    }
    if (!identity) {
      errors.push(`Marstal IF-kamprække ${rowIndex + 1} mangler stabilt matchid eller poolrowid`);
      return;
    }
    // DBU's matchid is the persistent match identity. poolrowid is needed to
    // resolve the current detail URL, but may change without creating a new
    // match when DBU moves it between programme rows.
    const sourceEventId = identity.matchId;
    if (identities.has(sourceEventId)) {
      errors.push(`Marstal IF returnerede kampidentiteten ${sourceEventId} flere gange`);
      return;
    }
    identities.add(sourceEventId);

    if (!currentMonth) {
      errors.push(`Marstal IF-kamp ${sourceEventId} mangler en forudgående månedsoverskrift`);
      return;
    }
    const dayMatch = cleanText(row.find(".theme_ClubFixtures_time .date").first().text()).match(/^(\d{1,2})\.$/);
    const day = dayMatch?.[1] ? Number(dayMatch[1]) : undefined;
    const time = parseTime(row.find(".theme_ClubFixtures_time .datetime > span").first().text());
    if (!day || !validCalendarDate(currentMonth.year, currentMonth.month, day) || !time) {
      errors.push(`Marstal IF-kamp ${sourceEventId} mangler gyldig dato eller tid`);
      return;
    }
    const date = isoDate(currentMonth.year, currentMonth.month, day);
    const localDate = DateTime.fromISO(date, { zone: COPENHAGEN });
    const weekdayText = cleanText(row.find(".theme_ClubFixtures_time .weekday").first().text())
      .toLocaleLowerCase("da-DK")
      .replace(/\.$/, "");
    if (!weekdayText || DANISH_WEEKDAYS[weekdayText] !== localDate.weekday) {
      errors.push(`Marstal IF-kamp ${sourceEventId} har en ugedag, der ikke matcher datoen`);
      return;
    }

    const homeTeam = uniqueText(
      row.find(".homeTeamName").toArray().map((item) => $(item).text()),
      "hjemmehold",
      sourceEventId,
      errors,
    );
    const awayTeam = uniqueText(
      row.find(".awayTeamName").toArray().map((item) => $(item).text()),
      "udehold",
      sourceEventId,
      errors,
    );
    const stadium = uniqueText(
      row.find(".theme_ClubFixtures_stadium .stadium").toArray().map((item) => $(item).text()),
      "spillesteder",
      sourceEventId,
      errors,
    );
    const competition = uniqueText(
      row.find(".theme_ClubFixtures_poolinfo").toArray().map((item) => $(item).text()),
      "række-/puljetekster",
      sourceEventId,
      errors,
    );
    if (!homeTeam || !awayTeam || !stadium || !competition) return;
    if (
      homeTeam.length > MAX_TEAM_NAME_LENGTH ||
      awayTeam.length > MAX_TEAM_NAME_LENGTH ||
      `${homeTeam} – ${awayTeam}`.length > 240
    ) {
      errors.push(`Marstal IF-kamp ${sourceEventId} har et for langt holdnavn`);
      return;
    }
    if (stadium.length > MAX_STADIUM_LENGTH) {
      errors.push(`Marstal IF-kamp ${sourceEventId} har et for langt spillested`);
      return;
    }
    if (competition.length > MAX_COMPETITION_LENGTH) {
      errors.push(`Marstal IF-kamp ${sourceEventId} har en for lang række-/puljetekst`);
      return;
    }

    if (localDate < today) {
      pastCount += 1;
      excludedSourceEventIds.add(sourceEventId);
      return;
    }
    if (!isMarstalHomeTeam(homeTeam)) {
      awayCount += 1;
      excludedSourceEventIds.add(sourceEventId);
      return;
    }
    if (!isMarstalStadium(stadium)) {
      nonLocalCount += 1;
      excludedSourceEventIds.add(sourceEventId);
      return;
    }

    const status = statusFromRow(cleanText(row.text()), row.attr("class") ?? "");
    candidates.push({
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title: `${homeTeam} – ${awayTeam}`,
      description: competition,
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: { name: stadium },
      occurrences: [{
        id: `dbu-${sourceEventId}`,
        date,
        startTime: time,
        allDay: false,
        timeUnknown: false,
      }],
      status,
      attendance: "public",
      publication: "trusted",
      reviewReasons: [],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: identity.sourceUrl,
        retrievedAt,
      },
    });
  });

  if (pastCount > 0) warnings.push(`${pastCount} historiske kamp${pastCount === 1 ? "" : "e"} blev udeladt`);
  if (awayCount > 0) warnings.push(`${awayCount} udekamp${awayCount === 1 ? "" : "e"} eller andre klubkampe blev udeladt`);
  if (nonLocalCount > 0) warnings.push(`${nonLocalCount} hjemmekamp${nonLocalCount === 1 ? "" : "e"} uden for Marstal Stadion blev udeladt`);
  if (candidates.length === 0) errors.push("Marstal IF-siden indeholder ingen fremtidige hjemmekampe på stadion i Marstal");

  return {
    candidates,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    excludedSourceEventIds: [...excludedSourceEventIds].sort(),
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseMarstalIfPage(html, retrievedAt, context.now);
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
      pagesFetched: 0,
      candidates: [],
      errors: [errorMessage(error)],
      warnings: [],
    };
  }
}

export const marstalIfSource: SourceAdapter = { definition, collect };
