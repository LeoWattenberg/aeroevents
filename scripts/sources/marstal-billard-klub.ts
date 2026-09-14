import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText, isoDate, validCalendarDate } from "./html";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["marstal-billard-klub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const DETAIL_PAGE = "https://www.ddbu-admin.dk/external/hold_kamp_res.php";
const DETAIL_ORIGIN = new URL(DETAIL_PAGE).origin;
const COPENHAGEN = "Europe/Copenhagen";
const MAX_MATCHES = 500;
const MAX_MATCH_ID_LENGTH = 20;
const MAX_TEAM_NAME_LENGTH = 110;
const REVIEW_REASONS = [
  "DDBU angiver ikke kampens starttid; datoen skal kontrolleres før publicering.",
  "Kilden oplyser ikke, om der er offentlig tilskueradgang.",
];

interface TableColumns {
  date: number;
  tournament: number;
  match: number;
  home: number;
  away: number;
}

export interface MarstalBillardKlubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  rawMatchCount: number;
  excludedSourceEventIds: string[];
}

function normalizedLabel(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase("da-DK")
    .replace(/[.:]+$/u, "");
}

function isMarstalBillardTeam(value: string): boolean {
  const team = normalizedLabel(value);
  return team === "marstal bk" || team === "marstal billard klub";
}

function parseDate(value: string): string | undefined {
  const match = cleanText(value).match(/^(\d{2})-(\d{2})-(20\d{2})$/u);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  return validCalendarDate(year, month, day) ? isoDate(year, month, day) : undefined;
}

function statusFromRow(value: string): EventStatus {
  if (/\b(?:aflyst|annulleret|cancelled|canceled)\b/iu.test(value)) return "cancelled";
  if (/\b(?:udsat|udskudt|flyttet|postponed)\b/iu.test(value)) return "postponed";
  return "scheduled";
}

function canonicalDetailUrl(matchId: string): string {
  const detail = new URL(DETAIL_PAGE);
  detail.searchParams.set("kampid", matchId);
  return detail.toString();
}

function safeDetailUrl(
  href: string | undefined,
  matchId: string,
): string | undefined {
  const canonical = canonicalDetailUrl(matchId);
  if (!href) return canonical;

  const safe = sameOriginHttpsUrl(href, DETAIL_ORIGIN);
  const parsed = new URL(safe);
  const ids = parsed.searchParams.getAll("kampid");
  const keys = [...parsed.searchParams.keys()];
  if (
    parsed.pathname !== "/external/hold_kamp_res.php" ||
    parsed.hash ||
    ids.length !== 1 ||
    ids[0] !== matchId ||
    keys.length !== 1 ||
    keys[0] !== "kampid"
  ) {
    return undefined;
  }
  return canonical;
}

function findColumns(labels: string[]): TableColumns | undefined {
  const index = (pattern: RegExp): number => labels.findIndex((label) => pattern.test(label));
  const columns = {
    date: index(/^dato$/u),
    // The live source currently misspells this as "Turneing".
    tournament: index(/^turne(?:r)?ing$/u),
    match: index(/^kampnr$/u),
    home: index(/^hjemmehold$/u),
    away: index(/^udehold$/u),
  };
  return Object.values(columns).every((column) => column >= 0) ? columns : undefined;
}

function countWarning(count: number, singular: string, plural: string, suffix: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? singular : plural} ${suffix}`;
}

export function parseMarstalBillardKlubPage(
  html: string,
  retrievedAt: string,
  now: Date,
): MarstalBillardKlubParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!/^DDBU\s*-\s*Billardresultater$/iu.test(cleanText($("title").first().text()))) {
    errors.push("DDBU-sidens platformidentitet mangler");
  }

  const scheduleTables = $("table").filter((_index, element) => {
    const headings = $(element)
      .find("td.head")
      .toArray()
      .map((cell) => cleanText($(cell).text()));
    return headings.some((heading) => /^Holdkampe resten af sæson+en$/iu.test(heading));
  });
  if (scheduleTables.length !== 1) {
    errors.push(`DDBU-siden indeholder ${scheduleTables.length} entydige tabeller med resterende holdkampe`);
    return { candidates: [], warnings, errors, rawMatchCount: 0, excludedSourceEventIds: [] };
  }

  const table = scheduleTables.first();
  const headerRows = table.find("tr").filter((_index, element) => {
    const labels = $(element)
      .children("th, td")
      .toArray()
      .map((cell) => normalizedLabel($(cell).text()));
    return findColumns(labels) !== undefined;
  });
  if (headerRows.length !== 1) {
    errors.push(`DDBU-kampprogrammet indeholder ${headerRows.length} entydige kolonneoverskrifter`);
    return { candidates: [], warnings, errors, rawMatchCount: 0, excludedSourceEventIds: [] };
  }

  const header = headerRows.first();
  const labels = header
    .children("th, td")
    .toArray()
    .map((cell) => normalizedLabel($(cell).text()));
  const columns = findColumns(labels);
  if (!columns) {
    errors.push("DDBU-kampprogrammets obligatoriske kolonner mangler");
    return { candidates: [], warnings, errors, rawMatchCount: 0, excludedSourceEventIds: [] };
  }

  const rows = header.nextAll("tr").filter((_index, element) => $(element).children("td").length > 0);
  const rawMatchCount = rows.length;
  if (rawMatchCount === 0) {
    errors.push("DDBU-kampprogrammet indeholder ingen kamprækker");
    return { candidates: [], warnings, errors, rawMatchCount, excludedSourceEventIds: [] };
  }
  if (rawMatchCount > MAX_MATCHES) {
    errors.push(`DDBU-kampprogrammet indeholder flere end ${MAX_MATCHES} kampe`);
    return { candidates: [], warnings, errors, rawMatchCount, excludedSourceEventIds: [] };
  }

  const today = DateTime.fromJSDate(now, { zone: COPENHAGEN }).startOf("day");
  if (!today.isValid) {
    return {
      candidates: [],
      warnings,
      errors: ["Indsamlingstidspunktet er ugyldigt"],
      rawMatchCount,
      excludedSourceEventIds: [],
    };
  }
  const rangeEnd = today.plus({ months: 12 });
  const candidates: NormalizedEventDraft[] = [];
  const identities = new Set<string>();
  const excludedSourceEventIds = new Set<string>();
  let marstalRows = 0;
  let pastCount = 0;
  let distantCount = 0;
  let awayCount = 0;
  let byeCount = 0;

  rows.each((rowIndex, element) => {
    const cells = $(element).children("td");
    const requiredLastColumn = Math.max(...Object.values(columns));
    if (cells.length <= requiredLastColumn) {
      errors.push(`DDBU-kamprække ${rowIndex + 1} har for få kolonner`);
      return;
    }
    const textAt = (column: number): string => cleanText(cells.eq(column).text());
    const visibleMatchId = textAt(columns.match);
    if (
      !new RegExp(`^[1-9]\\d{0,${MAX_MATCH_ID_LENGTH - 1}}$`, "u").test(visibleMatchId)
    ) {
      errors.push(`DDBU-kamprække ${rowIndex + 1} mangler et stabilt numerisk kamp-id`);
      return;
    }
    if (identities.has(visibleMatchId)) {
      errors.push(`DDBU returnerede kampidentiteten ${visibleMatchId} flere gange`);
      return;
    }
    identities.add(visibleMatchId);

    const matchCell = cells.eq(columns.match);
    const links = matchCell.find("a[href]").toArray();
    if (links.length > 1) {
      errors.push(`DDBU-kamp ${visibleMatchId} har flere detaljelinks`);
      return;
    }
    let sourceUrl: string | undefined;
    try {
      sourceUrl = safeDetailUrl(
        links[0] ? $(links[0]).attr("href") : undefined,
        visibleMatchId,
      );
    } catch (error) {
      errors.push(`DDBU-kamp ${visibleMatchId} har et usikkert detaljelink: ${errorMessage(error)}`);
      return;
    }
    if (!sourceUrl) {
      errors.push(`DDBU-kamp ${visibleMatchId} har et detaljelink, der ikke matcher kamp-id'et`);
      return;
    }

    const date = parseDate(textAt(columns.date));
    const tournament = textAt(columns.tournament);
    const homeTeam = textAt(columns.home);
    const awayTeam = textAt(columns.away);
    if (!date) errors.push(`DDBU-kamp ${visibleMatchId} mangler en gyldig eksplicit dato`);
    if (!tournament || tournament.length > 240) {
      errors.push(`DDBU-kamp ${visibleMatchId} mangler en gyldig turnering`);
    }
    if (
      homeTeam.length > MAX_TEAM_NAME_LENGTH ||
      awayTeam.length > MAX_TEAM_NAME_LENGTH ||
      `${homeTeam} – ${awayTeam}`.length > 240
    ) {
      errors.push(`DDBU-kamp ${visibleMatchId} har et for langt holdnavn`);
    }
    if (!homeTeam && !awayTeam) {
      errors.push(`DDBU-kamp ${visibleMatchId} mangler både hjemme- og udehold`);
    }

    const homeIsMarstal = isMarstalBillardTeam(homeTeam);
    const awayIsMarstal = isMarstalBillardTeam(awayTeam);
    if (homeIsMarstal || awayIsMarstal) marstalRows += 1;
    if (homeTeam && awayTeam && homeIsMarstal === awayIsMarstal) {
      errors.push(`DDBU-kamp ${visibleMatchId} tilhører ikke entydigt Marstal Billard Klub`);
    } else if ((!homeTeam || !awayTeam) && !homeIsMarstal && !awayIsMarstal) {
      errors.push(`DDBU-kamp ${visibleMatchId} mangler Marstal Billard Klub som hold`);
    }
    if (
      !date ||
      !tournament ||
      tournament.length > 240 ||
      homeTeam.length > MAX_TEAM_NAME_LENGTH ||
      awayTeam.length > MAX_TEAM_NAME_LENGTH ||
      `${homeTeam} – ${awayTeam}`.length > 240 ||
      (!homeTeam && !awayTeam)
    ) return;
    if ((!homeTeam || !awayTeam) && (homeIsMarstal || awayIsMarstal)) {
      byeCount += 1;
      excludedSourceEventIds.add(visibleMatchId);
      return;
    }
    if (homeIsMarstal === awayIsMarstal) return;

    const localDate = DateTime.fromISO(date, { zone: COPENHAGEN });
    if (localDate < today) {
      pastCount += 1;
      excludedSourceEventIds.add(visibleMatchId);
      return;
    }
    if (localDate > rangeEnd) {
      distantCount += 1;
      excludedSourceEventIds.add(visibleMatchId);
      return;
    }
    if (!homeIsMarstal) {
      awayCount += 1;
      excludedSourceEventIds.add(visibleMatchId);
      return;
    }

    candidates.push({
      sourceId: definition.id,
      sourceEventId: visibleMatchId,
      stableId: `${definition.id}-${visibleMatchId}`,
      title: `${homeTeam} – ${awayTeam}`,
      description: tournament,
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      location: {
        name: "Marstal Billard Klub",
        address: "Tordenskjoldsgade 20, 1.",
        postalCode: "5960",
        city: "Marstal",
      },
      occurrences: [{
        id: `ddbu-${visibleMatchId}`,
        date,
        allDay: false,
        timeUnknown: true,
      }],
      status: statusFromRow(cleanText($(element).text())),
      attendance: "unknown",
      attendanceDetails: "DDBU's kampprogram oplyser ikke, om kampen har offentlig tilskueradgang.",
      publication: "review",
      reviewReasons: [...REVIEW_REASONS],
      provenance: {
        sourceId: definition.id,
        externalId: visibleMatchId,
        sourceUrl,
        retrievedAt,
      },
    });
  });

  if (marstalRows === 0) errors.push("DDBU-kampprogrammets klubidentitet matcher ikke Marstal Billard Klub");
  const skippedWarnings = [
    countWarning(pastCount, "historisk kamp", "historiske kampe", "blev udeladt"),
    countWarning(distantCount, "fjern kamp", "fjerne kampe", "uden for tolvmånedersvinduet blev udeladt"),
    countWarning(awayCount, "udekamp", "udekampe", "blev udeladt"),
    countWarning(byeCount, "frirunde", "frirunder", "med blank modstander blev udeladt"),
  ].filter((warning): warning is string => Boolean(warning));
  warnings.push(...skippedWarnings);
  if (candidates.length === 0) {
    errors.push("DDBU returnerede ingen fremtidige hjemmekampe for Marstal Billard Klub");
  }

  return {
    candidates,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    rawMatchCount,
    excludedSourceEventIds: [...excludedSourceEventIds].sort(),
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseMarstalBillardKlubPage(html, retrievedAt, context.now);
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

export const marstalBillardKlubSource: SourceAdapter = { definition, collect };
