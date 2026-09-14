import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText, deduplicateBy } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventStatus,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["ommel-bk"];
const DBU_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const OMMEL_TEAM = /^Ommel BK(?:\s|\(|$)/iu;
const MAX_MATCHES = 500;

export interface DbuPoolSelection {
  /** DBU's current team id, read from the pool-selection input. */
  id: string;
  /** DBU's `pools` query uses the current zero-based row position, not this id. */
  queryIndex: number;
  competition: string;
  poolName: string;
}

export interface DbuClubPoolResult {
  pools: DbuPoolSelection[];
  warnings: string[];
  errors: string[];
}

export interface DbuMatch {
  matchId: string;
  poolId: string;
  date: string;
  time: string;
  competition: string;
  poolName: string;
  homeTeam: string;
  awayTeam: string;
  stadium: string;
  stadiumUrl?: string;
  sourceUrl: string;
  status: EventStatus;
}

export interface DbuMatchProgramResult {
  matches: DbuMatch[];
  warnings: string[];
  errors: string[];
}

function normalizedLabel(value: string): string {
  return cleanText(value).toLocaleLowerCase("da-DK").replace(/\s+/g, " ");
}

export function parseDbuClubPools(html: string): DbuClubPoolResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const clubName = cleanText($(".sr--header h2").first().text());
  if (!OMMEL_TEAM.test(clubName)) {
    errors.push("DBU-klubsiden tilhører ikke Ommel BK");
  }

  const inputs = $("#club-team-list input.SRPoolRowCB").toArray();
  const pools: DbuPoolSelection[] = [];
  inputs.forEach((input, queryIndex) => {
    const id = cleanText($(input).attr("value") ?? "");
    const row = $(input).closest("tr");
    const cells = row.children("td");
    const competition = cleanText($(input).closest("label").text());
    const poolName = cleanText(cells.eq(1).text());
    if (!/^[1-9]\d*$/.test(id) || !competition || !poolName) {
      errors.push(`DBU-puljerække ${queryIndex + 1} mangler id, række eller puljenavn`);
      return;
    }
    pools.push({ id, queryIndex, competition, poolName });
  });

  if (inputs.length === 0) errors.push("DBU-klubsiden indeholder ingen aktuelle puljer");
  if (new Set(pools.map((pool) => `${pool.id}:${pool.competition}`)).size !== pools.length) {
    warnings.push("DBU-klubsiden indeholder den samme hold/puljerække flere gange");
  }
  return { pools, warnings, errors };
}

export function dbuHomeMatchProgramUrl(pools: DbuPoolSelection[], now: Date): string {
  if (pools.length === 0) throw new Error("DBU-kampprogrammet kræver mindst én opdaget pulje");
  const today = DateTime.fromJSDate(now).setZone(COPENHAGEN).startOf("day");
  const url = new URL(definition.url);
  // This mirrors DBU's own ShowSelectedMatchPrograms implementation. Deriving
  // the indexes from the live rows avoids assuming that today's first row is
  // still the desired (or only) pool.
  url.searchParams.set("pools", pools.map((pool) => pool.queryIndex).join("_"));
  url.searchParams.set("fra", today.toFormat("dd-MM-yyyy"));
  url.searchParams.set("til", today.plus({ months: 12 }).toFormat("dd-MM-yyyy"));
  url.searchParams.set("hjemmekampe", "true");
  url.searchParams.set("udekampe", "false");
  return url.toString();
}

function parseDbuDate(value: string): string | undefined {
  const parts = cleanText(value).match(/\b(\d{1,2})-(\d{1,2})(?:\s+|-)(\d{4})\b/);
  if (!parts?.[1] || !parts[2] || !parts[3]) return undefined;
  const parsed = DateTime.fromFormat(
    `${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}-${parts[3]}`,
    "dd-MM-yyyy",
    { zone: COPENHAGEN },
  );
  return parsed.isValid ? parsed.toISODate()! : undefined;
}

function parseDbuTime(value: string): string | undefined {
  const parts = cleanText(value).match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  return parts?.[1] && parts[2] ? `${parts[1].padStart(2, "0")}:${parts[2]}` : undefined;
}

function statusFromRow(rowText: string, rowClass: string): EventStatus {
  const value = `${rowClass} ${rowText}`;
  if (/\b(?:aflyst|annulleret|cancelled|canceled)\b/iu.test(value)) return "cancelled";
  if (/\b(?:udsat|udskudt|postponed)\b/iu.test(value)) return "postponed";
  return "scheduled";
}

function teamName(
  cell: ReturnType<ReturnType<typeof load>> | undefined,
): string {
  if (!cell) return "";
  return cleanText(cell.find(".name-logo-remarks > span").last().text()) || cleanText(cell.text());
}

export function parseDbuMatchProgram(html: string): DbuMatchProgramResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const matches: DbuMatch[] = [];
  const clubName = cleanText($(".sr--header h2").first().text());
  if (!OMMEL_TEAM.test(clubName)) errors.push("DBU-kampprogrammet tilhører ikke Ommel BK");

  const table = $("table.match-program--table").first();
  if (table.length === 0) {
    errors.push("DBU-kampprogrammet mangler den forventede tabel");
    return { matches, warnings, errors };
  }
  const headings = table
    .find("thead th")
    .toArray()
    .map((heading) => normalizedLabel($(heading).text()));
  const column = (label: string) => headings.indexOf(normalizedLabel(label));
  const columns = {
    match: column("Kampnr"),
    date: column("Dato"),
    time: column("Tid"),
    pool: column("Række/Pulje"),
    home: column("Hjemme"),
    away: column("Ude"),
    stadium: column("Spillested"),
    result: column("Resultat"),
  };
  for (const [name, index] of Object.entries(columns)) {
    if (index < 0) errors.push(`DBU-kampprogrammet mangler kolonnen ${name}`);
  }
  if (errors.length > 0) return { matches, warnings, errors };

  table.find("tbody tr[onclick*='/resultater/kamp/']").each((rowIndex, element) => {
    const row = $(element);
    const onclick = row.attr("onclick") ?? "";
    const link = onclick.match(
      /MatchProgramMatchClick\(\s*['"]([^'"]*\/resultater\/kamp\/(\d+)_(\d+)\/kampinfo[^'"]*)['"]\s*\)/i,
    );
    if (!link?.[1] || !link[2] || !link[3]) {
      errors.push(`DBU-kamprække ${rowIndex + 1} mangler et stabilt kamp- og pulje-id`);
      return;
    }
    let sourceUrl: string;
    try {
      sourceUrl = sameOriginHttpsUrl(link[1], DBU_ORIGIN);
    } catch (error) {
      errors.push(`DBU-kamprække ${rowIndex + 1} har et usikkert link: ${errorMessage(error)}`);
      return;
    }

    const cells = row
      .children("td")
      .toArray()
      .filter((cell) => !$(cell).hasClass("only-on-mobile"))
      .map((cell) => $(cell));
    const textAt = (index: number) => cleanText(cells[index]?.text() ?? "");
    const matchId = link[2];
    const poolId = link[3];
    const displayedMatchId = textAt(columns.match);
    const date = parseDbuDate(textAt(columns.date));
    const time = parseDbuTime(textAt(columns.time));
    const poolCell = cells[columns.pool];
    const poolParts = poolCell?.find("span").toArray().map((part) => cleanText($(part).text())).filter(Boolean) ?? [];
    const competition = poolParts[0] ?? textAt(columns.pool);
    const poolName = poolParts.at(-1) ?? "";
    const homeTeam = teamName(cells[columns.home]);
    const awayTeam = teamName(cells[columns.away]);
    const stadiumCell = cells[columns.stadium];
    const stadium = cleanText(stadiumCell?.find("a").first().text() ?? stadiumCell?.text() ?? "");
    let stadiumUrl: string | undefined;
    const stadiumHref = stadiumCell?.find("a[href]").first().attr("href");
    if (stadiumHref) {
      try {
        stadiumUrl = sameOriginHttpsUrl(stadiumHref, DBU_ORIGIN);
      } catch (error) {
        errors.push(`DBU-kamp ${matchId} har et usikkert spillestedslink: ${errorMessage(error)}`);
      }
    }

    if (displayedMatchId !== matchId) errors.push(`DBU-kamp ${matchId} har et andet synligt kampnummer`);
    if (!date || !time) errors.push(`DBU-kamp ${matchId} mangler gyldig dato eller tid`);
    if (!competition || !poolName) errors.push(`DBU-kamp ${matchId} mangler række eller pulje`);
    if (!homeTeam || !awayTeam) errors.push(`DBU-kamp ${matchId} mangler hjemme- eller udehold`);
    if (!stadium) errors.push(`DBU-kamp ${matchId} mangler spillested`);
    if (!date || !time || !competition || !poolName || !homeTeam || !awayTeam || !stadium) return;

    matches.push({
      matchId,
      poolId,
      date,
      time,
      competition,
      poolName,
      homeTeam,
      awayTeam,
      stadium,
      ...(stadiumUrl ? { stadiumUrl } : {}),
      sourceUrl,
      status: statusFromRow(cleanText(row.text()), row.attr("class") ?? ""),
    });
  });

  if (matches.length > MAX_MATCHES) errors.push(`DBU returnerede flere end ${MAX_MATCHES} kampe`);
  const unique = deduplicateBy(matches, (match) => match.matchId);
  if (unique.length !== matches.length) errors.push("DBU returnerede samme kamp-id flere gange");
  return { matches: unique, warnings, errors };
}

function matchCandidate(match: DbuMatch, retrievedAt: string): NormalizedEventDraft {
  return {
    sourceId: definition.id,
    sourceEventId: match.matchId,
    stableId: `${definition.id}-${match.matchId}`,
    title: `${match.homeTeam} – ${match.awayTeam}`,
    description: `${match.competition} · ${match.poolName}`,
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: {
      name: match.stadium,
      ...(match.stadiumUrl ? { url: match.stadiumUrl } : {}),
    },
    occurrences: [{
      id: `dbu-${match.matchId}`,
      date: match.date,
      startTime: match.time,
      allDay: false,
      timeUnknown: false,
    }],
    status: match.status,
    attendance: "public",
    publication: "trusted",
    reviewReasons: [],
    provenance: {
      sourceId: definition.id,
      externalId: match.matchId,
      sourceUrl: match.sourceUrl,
      retrievedAt,
    },
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  let pagesFetched = 0;
  try {
    const clubHtml = await fetchText(context, definition.url, { expectedOrigin: DBU_ORIGIN });
    pagesFetched += 1;
    const club = parseDbuClubPools(clubHtml);
    warnings.push(...club.warnings);
    if (club.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: club.errors,
        warnings,
        discardedCandidateCount: 0,
      };
    }

    const programUrl = dbuHomeMatchProgramUrl(club.pools, context.now);
    const matchHtml = await fetchText(context, programUrl, { expectedOrigin: DBU_ORIGIN });
    pagesFetched += 1;
    const parsed = parseDbuMatchProgram(matchHtml);
    warnings.push(...parsed.warnings);
    const today = DateTime.fromJSDate(context.now).setZone(COPENHAGEN).startOf("day");
    const rangeEnd = today.plus({ months: 12 });
    const accepted = parsed.matches.filter((match) => {
      const date = DateTime.fromISO(match.date, { zone: COPENHAGEN });
      if (date < today || date > rangeEnd) {
        warnings.push(`DBU-kamp ${match.matchId} ligger uden for indsamlingsvinduet og blev udeladt`);
        return false;
      }
      if (!OMMEL_TEAM.test(match.homeTeam)) {
        warnings.push(`DBU-kamp ${match.matchId} er ikke en Ommel BK-hjemmekamp og blev udeladt`);
        return false;
      }
      return true;
    });
    const errors = [...parsed.errors];
    if (accepted.length === 0) errors.push("DBU returnerede ingen fremtidige Ommel BK-hjemmekampe");
    if (errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: [...new Set(errors)],
        warnings: [...new Set(warnings)],
        discardedCandidateCount: accepted.length,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: accepted.map((match) => matchCandidate(match, retrievedAt)),
      errors: [],
      warnings: [...new Set(warnings)],
    };
  } catch (error) {
    const failure = {
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [] as [],
      errors: [errorMessage(error)],
      warnings,
    };
    return pagesFetched === 0
      ? { status: "failed", ...failure }
      : { status: "partial", ...failure, discardedCandidateCount: 0 };
  }
}

export const ommelBkSource: SourceAdapter = { definition, collect };
