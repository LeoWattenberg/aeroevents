import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText } from "./html";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  NormalizedEventDraft,
  RecurringScheduleDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["aeroe-svoemmeklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const MAX_TEAMS = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REVIEW_REASON =
  "Holdet er en sæsonafgrænset gentagelse; ferieundtagelser og tilmeldingsstatus skal kontrolleres før publicering.";
const HOLIDAY_REVIEW_REASON =
  "Kilden oplyser, at enkelte hold kan holde ferie på andre datoer end den generelle ferieplan.";
const AMBIGUOUS_HOLIDAY_REVIEW_REASON =
  "Mindst én ferieangivelse kunne ikke omsættes sikkert og er derfor ikke medtaget som EXDATE.";

export const AEROE_SVOEMMEKLUB_PROGRAM_URL = definition.url;
export const AEROE_SVOEMMEKLUB_PLAN_URL = new URL(
  "/cms/TeamOverviewplan.aspx",
  definition.url,
).toString();
export const AEROE_SVOEMMEKLUB_CLOSURES_URL = new URL(
  "/lukkedage",
  definition.url,
).toString();

const WEEKDAY_CODES = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DANISH_WEEKDAYS = new Map([
  ["mandag", 1],
  ["tirsdag", 2],
  ["onsdag", 3],
  ["torsdag", 4],
  ["fredag", 5],
  ["lørdag", 6],
  ["søndag", 7],
]);
const DANISH_MONTHS = new Map([
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
const WEEKDAY_PATTERN = [...DANISH_WEEKDAYS.keys()].join("|");
const MONTH_PATTERN = [...DANISH_MONTHS.keys()].join("|");

interface ProgramTeam {
  code: string;
  title: string;
  ageFrom: number;
  ageTo: number;
  weekday: number;
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  location: string;
  price: string;
}

interface PlanTeam {
  code: string;
  title: string;
  teamId: string;
  bookingUrl: string;
  enrollmentStatus: "Tilmeld" | "Venteliste" | "Udsolgt";
  groupName: string;
}

interface ClosureRules {
  globalDates: Set<string>;
  childYouthDates: Set<string>;
}

export interface AeroeSvoemmeklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  rawTeamCount: number;
  season?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parsedNumericDate(value: string): DateTime | undefined {
  const match = cleanText(value).match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const date = DateTime.fromObject(
    { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) },
    { zone: COPENHAGEN },
  ).startOf("day");
  return date.isValid ? date : undefined;
}

function normalizedClock(hour: string, minute: string): string | undefined {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (
    !Number.isInteger(parsedHour) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    !Number.isInteger(parsedMinute) ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return undefined;
  }
  return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
}

function durationMinutes(startTime: string, endTime: string): number | undefined {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const duration = endHour! * 60 + endMinute! - (startHour! * 60 + startMinute!);
  return Number.isSafeInteger(duration) && duration > 0 && duration <= 8 * 60
    ? duration
    : undefined;
}

function parseProgramPage(html: string, errors: string[]): {
  teams: ProgramTeam[];
  season?: string;
  seasonStart?: number;
  seasonEnd?: number;
} {
  const $ = load(html);
  const root = $("#TeamOverviewProgramList");
  if (
    root.length !== 1 ||
    cleanText($("title").text()) !== "Program" ||
    !/Ærø Svømmeklub/iu.test(cleanText($("body").text()))
  ) {
    errors.push("Ærø Svømmeklubs programsideidentitet mangler eller er ændret");
    return { teams: [] };
  }

  const seasonText = cleanText($("#lblSeasonInfo").text());
  const seasonMatch = seasonText.match(/^Sæson\s+(20\d{2})\s*\/\s*(20\d{2})$/iu);
  const seasonStart = seasonMatch?.[1] ? Number(seasonMatch[1]) : undefined;
  const seasonEnd = seasonMatch?.[2] ? Number(seasonMatch[2]) : undefined;
  if (!seasonStart || seasonEnd !== seasonStart + 1) {
    errors.push("Ærø Svømmeklubs sæsonangivelse er ugyldig eller mangler");
  }

  const rows = root.find("tr[teamnumber]");
  if (rows.length === 0) errors.push("Ærø Svømmeklubs program indeholder ingen hold");
  if (rows.length > MAX_TEAMS) {
    errors.push(`Ærø Svømmeklubs program viser flere end ${MAX_TEAMS} hold`);
  }

  const teams: ProgramTeam[] = [];
  rows.each((index, element) => {
    const row = $(element);
    const number = index + 1;
    const cells = row.children("td");
    const code = cleanText(row.attr("teamnumber") ?? "");
    const title = cleanText(row.find(".teamtitle").first().text());
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(code)) {
      errors.push(`Svømmehold ${number} har et ugyldigt holdnummer`);
      return;
    }
    if (!title || title.length > 200 || cells.length !== 7) {
      errors.push(`Svømmehold ${code} har en ugyldig titel eller kolonnestruktur`);
      return;
    }

    const age = cleanText(cells.eq(1).text()).match(/^(\d{1,3})\s*[-–]\s*(\d{1,3})\s*år$/iu);
    const ageFrom = age?.[1] ? Number(age[1]) : Number.NaN;
    const ageTo = age?.[2] ? Number(age[2]) : Number.NaN;
    if (
      !Number.isInteger(ageFrom) ||
      !Number.isInteger(ageTo) ||
      ageFrom < 0 ||
      ageTo < ageFrom ||
      ageTo > 120
    ) {
      errors.push(`Svømmehold ${code} har et ugyldigt aldersinterval`);
      return;
    }

    const timeText = cleanText(cells.eq(2).text());
    const time = timeText.match(
      new RegExp(
        `^(${WEEKDAY_PATTERN})\\s+kl\\.?\\s*(\\d{1,2}):(\\d{2})\\s*[-–]\\s*(\\d{1,2}):(\\d{2})\\s+(.{1,200})$`,
        "iu",
      ),
    );
    const weekdayName = cleanText(row.find(".top_day").first().text()).toLocaleLowerCase("da-DK");
    const location = cleanText(row.find(".km-jq-local").first().text());
    const parsedWeekdayName = time?.[1]?.toLocaleLowerCase("da-DK");
    const weekday = parsedWeekdayName ? DANISH_WEEKDAYS.get(parsedWeekdayName) : undefined;
    const startTime = time?.[2] && time[3] ? normalizedClock(time[2], time[3]) : undefined;
    const endTime = time?.[4] && time[5] ? normalizedClock(time[4], time[5]) : undefined;
    if (
      !weekday ||
      parsedWeekdayName !== weekdayName ||
      !startTime ||
      !endTime ||
      cleanText(time?.[6] ?? "") !== location ||
      durationMinutes(startTime, endTime) === undefined
    ) {
      errors.push(`Svømmehold ${code} har en ugyldig ugedag eller et ugyldigt tidsinterval`);
      return;
    }

    const startAttribute = cleanText(row.attr("start") ?? "");
    const startText = cleanText(cells.eq(4).text());
    const endText = cleanText(cells.eq(5).text());
    const start = parsedNumericDate(startText);
    const end = parsedNumericDate(endText);
    if (
      startAttribute !== startText ||
      !start ||
      !end ||
      end < start ||
      start.weekday !== weekday ||
      end.weekday !== weekday ||
      (seasonStart !== undefined &&
        (start < DateTime.fromObject({ year: seasonStart, month: 7, day: 1 }, { zone: COPENHAGEN }) ||
          end > DateTime.fromObject({ year: seasonStart + 1, month: 6, day: 30 }, { zone: COPENHAGEN })))
    ) {
      errors.push(`Svømmehold ${code} har et ugyldigt sæsoninterval eller dato/ugedag matcher ikke`);
      return;
    }

    if (location !== "Svømmehallen, Bassin") {
      errors.push(`Svømmehold ${code} har et ukendt eller manglende svømmested`);
      return;
    }
    const price = cleanText(cells.eq(6).text());
    if (!/^\d{1,6}(?:[.,]\d{1,2})?\s*kr\.?$/iu.test(price)) {
      errors.push(`Svømmehold ${code} har en ugyldig pris`);
      return;
    }

    teams.push({
      code,
      title,
      ageFrom,
      ageTo,
      weekday,
      startTime,
      endTime,
      startDate: start.toISODate()!,
      endDate: end.toISODate()!,
      location,
      price,
    });
  });

  const codeKeys = teams.map((team) => team.code.toLocaleLowerCase("da-DK"));
  if (new Set(codeKeys).size !== codeKeys.length) {
    errors.push("Ærø Svømmeklubs program indeholder dublerede holdnumre");
  }
  return {
    teams,
    ...(seasonStart && seasonEnd
      ? { season: `${seasonStart}/${seasonEnd}`, seasonStart, seasonEnd }
      : {}),
  };
}

function parsePlanPage(html: string, errors: string[]): PlanTeam[] {
  const $ = load(html);
  const root = $("#km-teamoverviewplanwrapper");
  if (root.length !== 1 || !/Ærø Svømmeklub/iu.test(cleanText($("body").text()))) {
    errors.push("Ærø Svømmeklubs holdplansideidentitet mangler eller er ændret");
    return [];
  }
  const wrappers = root.find(".team-item-wrapper[teamnr]");
  if (wrappers.length === 0) errors.push("Ærø Svømmeklubs holdplan indeholder ingen hold");
  if (wrappers.length > MAX_TEAMS) {
    errors.push(`Ærø Svømmeklubs holdplan viser flere end ${MAX_TEAMS} hold`);
  }

  const teams: PlanTeam[] = [];
  wrappers.each((index, element) => {
    const wrapper = $(element);
    const code = cleanText(wrapper.attr("teamnr") ?? "");
    const title = cleanText(wrapper.find(".team-header .bold span").first().text());
    const groupName = cleanText(wrapper.attr("groupname") ?? "");
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(code) || !title || title.length > 200 || !groupName) {
      errors.push(`Holdplanens række ${index + 1} har ugyldig identitet`);
      return;
    }

    const enrollmentLinks = wrapper.find("a[href*='ProfileMaintainEnrollment.aspx']");
    const statuses = wrapper.find(".team-signup .open, .team-signup .wait, .team-signup .sold");
    if (enrollmentLinks.length !== 1 || statuses.length !== 1) {
      errors.push(`Svømmehold ${code} har ikke præcis ét sikkert tilmeldingslink og én status`);
      return;
    }
    const statusText = cleanText(statuses.first().text());
    const enrollmentStatus =
      statusText === "Tilmeld" || statusText === "Venteliste" || statusText === "Udsolgt"
        ? statusText
        : undefined;
    if (!enrollmentStatus) {
      errors.push(`Svømmehold ${code} har en ukendt tilmeldingsstatus`);
      return;
    }

    let bookingUrl: string;
    try {
      bookingUrl = sameOriginHttpsUrl(
        enrollmentLinks.first().attr("href") ?? "",
        AEROE_SVOEMMEKLUB_PLAN_URL,
      );
    } catch {
      errors.push(`Svømmehold ${code} har et usikkert tilmeldingslink`);
      return;
    }
    const parsedUrl = new URL(bookingUrl);
    const teamId = parsedUrl.searchParams.get("TeamID") ?? "";
    if (
      parsedUrl.pathname.toLocaleLowerCase("en-US") !==
        "/cms/profilemaintainenrollment.aspx" ||
      parsedUrl.hash ||
      parsedUrl.searchParams.size !== 1 ||
      !/^[1-9]\d{0,9}$/.test(teamId)
    ) {
      errors.push(`Svømmehold ${code} har et ugyldigt TeamID-link`);
      return;
    }
    teams.push({ code, title, teamId, bookingUrl, enrollmentStatus, groupName });
  });

  const codeKeys = teams.map((team) => team.code.toLocaleLowerCase("da-DK"));
  if (new Set(codeKeys).size !== codeKeys.length) {
    errors.push("Ærø Svømmeklubs holdplan indeholder dublerede holdnumre");
  }
  if (new Set(teams.map((team) => team.teamId)).size !== teams.length) {
    errors.push("Ærø Svømmeklubs holdplan indeholder dublerede TeamID'er");
  }
  return teams;
}

function dateFromDanishWords(
  weekdayName: string,
  dayText: string,
  monthName: string,
  yearText: string,
): DateTime | undefined {
  const weekday = DANISH_WEEKDAYS.get(weekdayName.toLocaleLowerCase("da-DK"));
  const month = DANISH_MONTHS.get(monthName.toLocaleLowerCase("da-DK"));
  if (!weekday || !month) return undefined;
  const date = DateTime.fromObject(
    { year: Number(yearText), month, day: Number(dayText) },
    { zone: COPENHAGEN },
  ).startOf("day");
  return date.isValid && date.weekday === weekday ? date : undefined;
}

function addRange(target: Set<string>, start: DateTime, end: DateTime): void {
  for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
    target.add(cursor.toISODate()!);
  }
}

function parseClosurePage(
  html: string,
  seasonStart: number,
  seasonEnd: number,
  warnings: string[],
  errors: string[],
): ClosureRules {
  const $ = load(html);
  const root = $("#ctl00_ContentPlaceHolderBody_lblPageContent");
  if (
    root.length !== 1 ||
    cleanText($("title").text()) !== "Lukkedage" ||
    cleanText($("h1").first().text()) !== "Lukkedage i Ærø Svømmeklub"
  ) {
    errors.push("Ærø Svømmeklubs lukkedagssideidentitet mangler eller er ændret");
    return { globalDates: new Set(), childYouthDates: new Set() };
  }
  const text = cleanText(root.text());
  const expectedHeading = `Ferieplan ${seasonStart}/${String(seasonEnd).slice(-2)}`;
  if (!text.includes(expectedHeading)) {
    errors.push("Ærø Svømmeklubs ferieplan matcher ikke programsæsonen");
    return { globalDates: new Set(), childYouthDates: new Set() };
  }

  const globalDates = new Set<string>();
  const childYouthDates = new Set<string>();
  const seasonFloor = DateTime.fromObject({ year: seasonStart, month: 7, day: 1 }, { zone: COPENHAGEN });
  const seasonCeiling = DateTime.fromObject({ year: seasonEnd, month: 6, day: 30 }, { zone: COPENHAGEN });
  const rangeLabels = [
    "Efterårsferie",
    "Juleferie",
    "Vinterferie",
    "Påskeferie",
    "Kr. Himmelfartsferie",
    "Pinseferie",
  ];
  for (const label of rangeLabels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(
      new RegExp(
        `${escapedLabel}\\s*(${WEEKDAY_PATTERN})\\s+(\\d{1,2})\\.?\\s+(${MONTH_PATTERN})\\s+(20\\d{2})\\s*[-–]\\s*(${WEEKDAY_PATTERN})\\s+(\\d{1,2})\\.?\\s+(${MONTH_PATTERN})\\s+(20\\d{2})`,
        "iu",
      ),
    );
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6] || !match[7] || !match[8]) {
      warnings.push(`${label} kunne ikke aflæses sikkert og er ikke tilføjet som undtagelse`);
      continue;
    }
    const start = dateFromDanishWords(match[1], match[2], match[3], match[4]);
    const end = dateFromDanishWords(match[5], match[6], match[7], match[8]);
    if (
      !start ||
      !end ||
      end < start ||
      end.diff(start, "days").days > 31 ||
      start < seasonFloor ||
      end > seasonCeiling
    ) {
      warnings.push(`${label} har modstridende eller ugyldige datoer og er ikke tilføjet som undtagelse`);
      continue;
    }
    addRange(globalDates, start, end);
  }

  const fastelavn = text.match(
    new RegExp(
      `Fastelavnsmandag\\s*(${WEEKDAY_PATTERN})\\s+(\\d{1,2})\\.?\\s+(${MONTH_PATTERN})\\s+(20\\d{2})`,
      "iu",
    ),
  );
  if (fastelavn?.[1] && fastelavn[2] && fastelavn[3] && fastelavn[4]) {
    const date = dateFromDanishWords(fastelavn[1], fastelavn[2], fastelavn[3], fastelavn[4]);
    if (date && date >= seasonFloor && date <= seasonCeiling && /børne-\s*og\s+ungdomshold/iu.test(text)) {
      childYouthDates.add(date.toISODate()!);
    } else {
      warnings.push("Fastelavnsmandag kunne ikke knyttes sikkert til børne- og ungdomsholdene");
    }
  } else {
    warnings.push("Fastelavnsmandag kunne ikke aflæses sikkert og er ikke tilføjet som undtagelse");
  }
  if (/enkelte hold holder juleferie tidligere/iu.test(text)) {
    warnings.push("Enkelte hold kan holde juleferie tidligere; de holds særlige datoer kræver manuelt gennemsyn");
  }
  return { globalDates, childYouthDates };
}

function scheduleFor(team: ProgramTeam, closureDates: Set<string>): RecurringScheduleDraft {
  const weekdayCode = WEEKDAY_CODES[team.weekday]!;
  const exdates = [...closureDates]
    .filter((value) => {
      const date = DateTime.fromISO(value, { zone: COPENHAGEN });
      return date >= DateTime.fromISO(team.startDate, { zone: COPENHAGEN }) &&
        date <= DateTime.fromISO(team.endDate, { zone: COPENHAGEN }) &&
        date.weekday === team.weekday;
    })
    .sort()
    .map((date) => `${date}T${team.startTime}`);
  return {
    kind: "recurring",
    dtstart: { kind: "timed", date: team.startDate, startTime: team.startTime },
    rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode};UNTIL=${team.endDate.replaceAll("-", "")}T${team.startTime.replace(":", "")}00`,
    rdates: [],
    exdates,
    overrides: [],
    durationMinutes: durationMinutes(team.startTime, team.endTime)!,
  };
}

export function parseAeroeSvoemmeklubPages(
  programHtml: string,
  planHtml: string,
  closuresHtml: string,
  retrievedAt: string,
): AeroeSvoemmeklubParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const program = parseProgramPage(programHtml, errors);
  const planTeams = parsePlanPage(planHtml, errors);
  const closureRules =
    program.seasonStart && program.seasonEnd
      ? parseClosurePage(closuresHtml, program.seasonStart, program.seasonEnd, warnings, errors)
      : { globalDates: new Set<string>(), childYouthDates: new Set<string>() };

  const planByCode = new Map(
    planTeams.map((team) => [team.code.toLocaleLowerCase("da-DK"), team]),
  );
  if (program.teams.length !== planTeams.length) {
    errors.push("Program og holdplan indeholder ikke samme antal hold");
  }
  for (const team of program.teams) {
    const plan = planByCode.get(team.code.toLocaleLowerCase("da-DK"));
    if (!plan) {
      errors.push(`Svømmehold ${team.code} mangler en entydig TeamID-kobling i holdplanen`);
    } else if (plan.title !== team.title) {
      errors.push(`Svømmehold ${team.code} har forskellige titler i program og holdplan`);
    }
  }
  const programCodes = new Set(
    program.teams.map((team) => team.code.toLocaleLowerCase("da-DK")),
  );
  for (const team of planTeams) {
    if (!programCodes.has(team.code.toLocaleLowerCase("da-DK"))) {
      errors.push(`Holdplanens svømmehold ${team.code} mangler i programlisten`);
    }
  }

  if (errors.length > 0) {
    return {
      candidates: [],
      warnings: unique(warnings),
      errors: unique(errors),
      rawTeamCount: program.teams.length,
      ...(program.season ? { season: program.season } : {}),
    };
  }

  const candidates = program.teams.map((team): NormalizedEventDraft => {
    const plan = planByCode.get(team.code.toLocaleLowerCase("da-DK"))!;
    const childYouth =
      plan.groupName.startsWith("Forældre_") || plan.groupName.startsWith("Svømmeskole_");
    const dates = new Set(closureRules.globalDates);
    if (childYouth) {
      for (const date of closureRules.childYouthDates) dates.add(date);
    }
    const sourceEventId = `team-${plan.teamId}`;
    return {
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title: team.title,
      description: `Fast ugentligt svømmehold ${team.code} i sæson ${program.season}.`,
      organizerId: definition.organizerId,
      categoryIds: childYouth
        ? [...definition.categoryIds]
        : definition.categoryIds.filter((categoryId) => categoryId !== "boern-familie"),
      location: {
        name: "Ærø Svømmehal",
        address: "Markgade 1",
        postalCode: "5960",
        city: "Marstal",
      },
      schedule: scheduleFor(team, dates),
      occurrences: [],
      status: "scheduled",
      availability:
        plan.enrollmentStatus === "Tilmeld"
          ? "available"
          : plan.enrollmentStatus === "Udsolgt"
            ? "sold-out"
            : "unknown",
      attendance: "registration",
      attendanceDetails: `Holdoversigten angiver målgruppen som ${team.ageFrom}–${team.ageTo} år.`,
      price: team.price,
      bookingUrl: plan.bookingUrl,
      bookingRequired: true,
      bookingDetails: `Aktuel tilmeldingsstatus på kilden: ${plan.enrollmentStatus}.`,
      publication: "review",
      reviewReasons: [
        REVIEW_REASON,
        HOLIDAY_REVIEW_REASON,
        ...(warnings.length > 0 ? [AMBIGUOUS_HOLIDAY_REVIEW_REASON] : []),
      ],
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl: definition.url,
        retrievedAt,
      },
    };
  });

  return {
    candidates,
    warnings: unique(warnings),
    errors: [],
    rawTeamCount: program.teams.length,
    ...(program.season ? { season: program.season } : {}),
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  let pagesFetched = 0;
  try {
    const programHtml = await fetchText(context, AEROE_SVOEMMEKLUB_PROGRAM_URL, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: MAX_BODY_BYTES,
    });
    pagesFetched += 1;
    const planHtml = await fetchText(context, AEROE_SVOEMMEKLUB_PLAN_URL, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: MAX_BODY_BYTES,
    });
    pagesFetched += 1;
    const closuresHtml = await fetchText(context, AEROE_SVOEMMEKLUB_CLOSURES_URL, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: MAX_BODY_BYTES,
    });
    pagesFetched += 1;

    const parsed = parseAeroeSvoemmeklubPages(
      programHtml,
      planHtml,
      closuresHtml,
      retrievedAt,
    );
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        warnings: parsed.warnings,
        errors: parsed.errors,
        discardedCandidateCount: parsed.rawTeamCount,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: parsed.candidates,
      snapshotCoverage: "authoritative",
      excludedSourceEventIds: [],
      warnings: parsed.warnings,
      errors: [],
    };
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      warnings: [],
      errors: [errorMessage(error)],
    };
  }
}

export const aeroeSvoemmeklubSource: SourceAdapter = { definition, collect };
