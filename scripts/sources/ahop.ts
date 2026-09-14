import { load } from "cheerio";
import { DateTime } from "luxon";

import { normalizedTime, weeklySchedule } from "./fixed-schedule";
import { cleanText } from "./html";
import { errorMessage, fetchJson, sameOriginHttpsUrl } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  Attendance,
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  RecurringScheduleDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY.ahop;
const SOURCE_ORIGIN = new URL(definition.url).origin;
const COPENHAGEN = "Europe/Copenhagen";
const MAX_RESPONSE_BYTES = 512 * 1024;

export const AHOP_PAGE_IDS = [42, 31, 32, 33, 276, 28, 41] as const;
export const MAX_AHOP_RESPONSE_RECORDS = 25;

const apiUrl = new URL("/wp-json/wp/v2/pages", SOURCE_ORIGIN);
apiUrl.searchParams.set("include", [...AHOP_PAGE_IDS].sort((left, right) => left - right).join(","));
apiUrl.searchParams.set("per_page", String(AHOP_PAGE_IDS.length));
apiUrl.searchParams.set("orderby", "include");
apiUrl.searchParams.set(
  "_fields",
  "id,slug,modified,link,status,title,content",
);
export const AHOP_API_URL = apiUrl.toString();

const COMMON_REVIEW_REASON =
  "Kilden angiver en fast ugeaktivitet uden slutdato eller undtagelser; gentagelsesreglen skal kontrolleres før publicering.";
const UNKNOWN_ACCESS_REASON =
  "Adgang for ikke-medlemmer fremgår ikke entydigt af aktivitetssiden.";
const MEMBER_ACCESS_REASON =
  "AHOPs medlemsinformation beskriver værkstedsbrug som et medlemstilbud; den aktuelle adgang skal kontrolleres.";

interface AhopPageSpec {
  id: (typeof AHOP_PAGE_IDS)[number];
  slug: string;
  canonicalUrl: string;
  title: string | ((weekday: number) => string);
  description: string;
  contentMarker: RegExp;
  attendance: Attendance;
  attendanceDetails: string;
  location: EventLocationDraft;
  organizerName?: string;
}

const AHOP_LOCATION: EventLocationDraft = {
  name: "Aktivitetshuset OvenPaa",
  address: "Vestergade 52A",
  postalCode: "5970",
  city: "Ærøskøbing",
};

const weekdayTitle = (weekday: number): string => {
  const names = ["", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
  return `Strik ${names[weekday] ?? "ukendt ugedag"} aften`;
};

const PAGE_SPECS: readonly AhopPageSpec[] = [
  {
    id: 42,
    slug: "dart",
    canonicalUrl: "https://ahop.dk/dart/",
    title: "Dart",
    description: "Dart i Ærøskøbing Dartklub i Aktivitetshuset OvenPaa.",
    contentMarker: /Ærøskøbing\s+Dartklub/iu,
    attendance: "unknown",
    attendanceDetails: "Aktivitetssiden siger, at man kan møde op, men oplyser ikke entydigt, om medlemskab kræves.",
    location: { ...AHOP_LOCATION, name: "Ærøskøbing Dartklub / Aktivitetshuset OvenPaa" },
    organizerName: "Ærøskøbing Dartklub",
  },
  {
    id: 31,
    slug: "hjemloese-strik",
    canonicalUrl: "https://ahop.dk/hjemloese-strik/",
    title: "Hjemløse strik",
    description: "Fælles strikning af varme ting til udsatte i Odense.",
    contentMarker: /strikker\s+vi[\s\S]{0,180}\btil\s+hjemløse\b/iu,
    attendance: "unknown",
    attendanceDetails: "Aktivitetssiden siger, at man kan møde op, men oplyser ikke entydigt, om medlemskab kræves.",
    location: { ...AHOP_LOCATION, name: "Aktivitetshuset OvenPaa, fællesrummet" },
  },
  {
    id: 32,
    slug: "strik-tirsdag-aften",
    canonicalUrl: "https://ahop.dk/strik-tirsdag-aften/",
    title: weekdayTitle,
    description: "Fælles strikkeaften med kaffe i Aktivitetshuset OvenPaa.",
    contentMarker: /Vi\s+strikker,?\s+drikker\s+kaffe/iu,
    attendance: "unknown",
    attendanceDetails: "Aktivitetssiden byder interesserede velkommen, men oplyser ikke entydigt, om medlemskab kræves.",
    location: { ...AHOP_LOCATION, name: "Aktivitetshuset OvenPaa, fællesrummet" },
  },
  {
    id: 33,
    slug: "strik-torsdag-aften",
    canonicalUrl: "https://ahop.dk/strik-torsdag-aften/",
    title: weekdayTitle,
    description: "Fælles strikkeaften i Aktivitetshuset OvenPaa.",
    contentMarker: /Ahops\s+fællesrum\s+på\s+1\.\s*sal/iu,
    attendance: "unknown",
    attendanceDetails: "Aktivitetssiden oplyser ikke, om ikke-medlemmer kan deltage.",
    location: { ...AHOP_LOCATION, name: "Aktivitetshuset OvenPaa, fællesrummet" },
  },
  {
    id: 276,
    slug: "keramikvaerksted",
    canonicalUrl: "https://ahop.dk/keramikvaerksted/",
    title: "Keramikværksted",
    description: "Fælles værkstedstid med stentøjsler, hvor deltagerne hjælper hinanden og deler erfaringer.",
    contentMarker: /keramikværkstedet[\s\S]{0,500}\bstentøjsler\b/iu,
    attendance: "members",
    attendanceDetails: "Aktivitetssiden angiver, at deltagelse i keramikværkstedet kræver medlemskab af AHOP.",
    location: { ...AHOP_LOCATION, name: "Aktivitetshuset OvenPaa, keramikværkstedet" },
  },
  {
    id: 28,
    slug: "vaevevaerksted",
    canonicalUrl: "https://ahop.dk/vaevevaerksted/",
    title: "Væveværksted",
    description: "Fælles værkstedstid for øvede, let øvede og nybegyndere.",
    contentMarker: /vævegruppen\s+hjælper\s+vi\s+hinanden/iu,
    attendance: "members",
    attendanceDetails: "AHOPs medlemsinformation beskriver værkstedsbrug som et medlemstilbud.",
    location: { ...AHOP_LOCATION, name: "Aktivitetshuset OvenPaa, væveværkstedet" },
  },
  {
    id: 41,
    slug: "traevaerksted",
    canonicalUrl: "https://ahop.dk/traevaerksted/",
    title: "Træværksted",
    description: "Fælles træværksted på Rise gamle Skole.",
    contentMarker: /Træværksted[\s\S]{0,200}\bRise\s+gamle\s+Skole\b/iu,
    attendance: "members",
    attendanceDetails: "AHOPs medlemsinformation beskriver værkstedsbrug som et medlemstilbud.",
    location: { name: "Rise gamle Skole", postalCode: "5970", city: "Ærøskøbing" },
  },
];

const PAGE_SPECS_BY_ID = new Map<number, AhopPageSpec>(
  PAGE_SPECS.map((spec) => [spec.id, spec]),
);
const WEEKDAYS = new Map<string, number>([
  ["mandag", 1],
  ["mandage", 1],
  ["tirsdag", 2],
  ["tirsdage", 2],
  ["onsdag", 3],
  ["onsdage", 3],
  ["torsdag", 4],
  ["torsdage", 4],
  ["fredag", 5],
  ["fredage", 5],
  ["lørdag", 6],
  ["lørdage", 6],
  ["søndag", 7],
  ["søndage", 7],
]);
const WEEKDAY_PATTERN =
  "mandag(?:e)?|tirsdag(?:e)?|onsdag(?:e)?|torsdag(?:e)?|fredag(?:e)?|lørdag(?:e)?|søndag(?:e)?";

interface ParsedRule {
  weekday: number;
  startTime: string;
  endTime?: string;
}

interface ParsedPage {
  id: AhopPageSpec["id"];
  title: string;
  body: string;
  sourceUrl: string;
  sourceModifiedAt: string;
  rule: ParsedRule;
}

export interface AhopParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
  discardedCandidateCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positivePageId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function renderedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) return undefined;
  const $ = load(`<main>${value}</main>`);
  $("style, script, noscript, template, svg").remove();
  $("br, p, div, section, li, h1, h2, h3, h4, h5, h6").each((_index, element) => {
    $(element).append(" ");
  });
  const result = cleanText($("main").text());
  return result || undefined;
}

function modifiedInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(value)) {
    return undefined;
  }
  const parsed = DateTime.fromISO(value, { zone: COPENHAGEN });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value) return undefined;
  return parsed.toUTC().toISO()!;
}

function titleWeekday(title: string): number | undefined {
  const weekday = title.match(new RegExp(`\\b(${WEEKDAY_PATTERN})\\b`, "iu"))?.[1];
  return weekday ? WEEKDAYS.get(weekday.toLocaleLowerCase("da-DK")) : undefined;
}

function parseWeeklyRule(body: string): ParsedRule | undefined {
  const anchors = [...body.matchAll(
    new RegExp(
      `\\b(${WEEKDAY_PATTERN})\\b\\s+(?:(?:fra\\s+)(?:kl\\.?\\s*)?|(?:kl\\.?\\s*))(?=\\d)`,
      "giu",
    ),
  )];
  if (anchors.length !== 1) return undefined;

  const anchor = anchors[0]!;
  const weekdayName = anchor[1]?.toLocaleLowerCase("da-DK");
  const weekday = weekdayName ? WEEKDAYS.get(weekdayName) : undefined;
  const remainder = body.slice((anchor.index ?? 0) + anchor[0].length);
  const time = remainder.match(
    /^(\d{1,2})(?:[.:](\d{2}))?(?:\s*[-–—]\s*(\d{1,2})(?:[.:](\d{2}))?)?/u,
  );
  if (!weekday || !time?.[1]) return undefined;

  const trailing = remainder.slice(time[0].length);
  if (/^[.:]\d/u.test(trailing)) return undefined;
  if (trailing && !/^[\s,;.!?)]/u.test(trailing)) return undefined;
  const startTime = normalizedTime(time[1], time[2] ?? "00");
  const endTime = time[3] ? normalizedTime(time[3], time[4] ?? "00") : undefined;
  if (!startTime || (time[3] && !endTime) || (endTime && endTime <= startTime)) {
    return undefined;
  }
  return { weekday, startTime, ...(endTime ? { endTime } : {}) };
}

function scheduleFor(rule: ParsedRule): RecurringScheduleDraft {
  if (rule.endTime) return weeklySchedule(rule.weekday, rule.startTime, rule.endTime);
  const dates = ["", "2000-01-03", "2000-01-04", "2000-01-05", "2000-01-06", "2000-01-07", "2000-01-08", "2000-01-09"];
  const codes = ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  return {
    kind: "recurring",
    dtstart: { kind: "timed", date: dates[rule.weekday]!, startTime: rule.startTime },
    startDateUnknown: true,
    rrule: `FREQ=WEEKLY;BYDAY=${codes[rule.weekday]}`,
    rdates: [],
    exdates: [],
    overrides: [],
  };
}

function parsePage(
  value: Record<string, unknown>,
  spec: AhopPageSpec,
  errors: string[],
): ParsedPage | undefined {
  const initialErrorCount = errors.length;
  const prefix = `AHOP-side ${spec.id}`;
  const slug = typeof value.slug === "string" ? value.slug : undefined;
  const titleObject = record(value.title);
  const contentObject = record(value.content);
  const publiclyReadable = value.status === "publish" && contentObject?.protected === false;
  // Do not inspect or carry forward the body of a private/password-protected page.
  const title = publiclyReadable ? renderedText(titleObject?.rendered, 500) : undefined;
  const body = publiclyReadable ? renderedText(contentObject.rendered, 300_000) : undefined;
  const sourceModifiedAt = modifiedInstant(value.modified);
  let sourceUrl: string | undefined;
  try {
    sourceUrl = typeof value.link === "string"
      ? sameOriginHttpsUrl(value.link, SOURCE_ORIGIN)
      : undefined;
  } catch {
    sourceUrl = undefined;
  }

  if (slug !== spec.slug) errors.push(`${prefix} har et uventet WordPress-slug`);
  if (value.status !== "publish") errors.push(`${prefix} er ikke offentligt publiceret`);
  if (contentObject?.protected !== false) errors.push(`${prefix} er beskyttet eller mangler offentlighedsmarkering`);
  if (publiclyReadable && !title) errors.push(`${prefix} mangler en gyldig WordPress-titel`);
  if (publiclyReadable && !body) errors.push(`${prefix} mangler læsbar offentlig brødtekst`);
  if (sourceUrl !== spec.canonicalUrl) errors.push(`${prefix} mangler det forventede sikre canonical-link`);
  if (!sourceModifiedAt) errors.push(`${prefix} mangler et gyldigt ændringstidspunkt`);
  if (body && !spec.contentMarker.test(body)) errors.push(`${prefix} mangler sin forventede aktivitetsmarkør`);
  const rule = body ? parseWeeklyRule(body) : undefined;
  if (publiclyReadable && !rule) {
    errors.push(`${prefix} har en manglende, flertydig eller ugyldig ugeregel i brødteksten`);
  }

  if (
    errors.length > initialErrorCount ||
    !title ||
    !body ||
    !sourceUrl ||
    !sourceModifiedAt ||
    !rule
  ) return undefined;
  return { id: spec.id, title, body, sourceUrl, sourceModifiedAt, rule };
}

function candidateFromPage(
  page: ParsedPage,
  spec: AhopPageSpec,
  retrievedAt: string,
  warnings: string[],
): NormalizedEventDraft {
  const sourceEventId = `page-${page.id}`;
  const titleDay = titleWeekday(page.title);
  const titleConflict = titleDay !== undefined && titleDay !== page.rule.weekday;
  if (titleConflict) {
    warnings.push(
      `AHOP-side ${page.id}: WordPress-titlens ugedag afviger fra brødtekstens ugeregel; brødteksten blev anvendt`,
    );
  }
  const approximateRule = /\b(?:som\s+regel|så\s+vidt\s+muligt)\b/iu.test(page.body);
  const reviewReasons = [
    COMMON_REVIEW_REASON,
    spec.attendance === "members" ? MEMBER_ACCESS_REASON : UNKNOWN_ACCESS_REASON,
    ...(page.rule.endTime ? [] : ["Brødteksten angiver ingen sluttid; varighed er derfor ikke udfyldt."]),
    ...(approximateRule
      ? ["Brødteksten tager forbehold for, om aktiviteten mødes hver uge."]
      : []),
    ...(titleConflict
      ? ["WordPress-titlens ugedag strider mod brødteksten; brødtekstens regel er anvendt."]
      : []),
  ];
  return {
    sourceId: definition.id,
    sourceEventId,
    stableId: `${definition.id}-${sourceEventId}`,
    title: typeof spec.title === "function" ? spec.title(page.rule.weekday) : spec.title,
    description: spec.description,
    organizerId: definition.organizerId,
    ...(spec.organizerName ? { organizerName: spec.organizerName } : {}),
    categoryIds: [...definition.categoryIds],
    location: { ...spec.location },
    schedule: scheduleFor(page.rule),
    occurrences: [],
    status: "scheduled",
    attendance: spec.attendance,
    attendanceDetails: spec.attendanceDetails,
    publication: "review",
    reviewReasons,
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl: page.sourceUrl,
      sourceModifiedAt: page.sourceModifiedAt,
      retrievedAt,
    },
  };
}

export function parseAhopPages(
  value: unknown,
  retrievedAt: string,
): AhopParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    return {
      candidates: [],
      warnings,
      errors: ["AHOPs WordPress-API returnerede ikke en liste af sider"],
      discardedCandidateCount: 0,
    };
  }
  if (value.length > MAX_AHOP_RESPONSE_RECORDS) {
    return {
      candidates: [],
      warnings,
      errors: [`AHOPs WordPress-API returnerede flere end ${MAX_AHOP_RESPONSE_RECORDS} poster`],
      discardedCandidateCount: 0,
    };
  }

  const pages = new Map<number, Record<string, unknown>>();
  const unexpectedIds = new Set<number>();
  value.forEach((item, index) => {
    const page = record(item);
    const id = positivePageId(page?.id);
    if (!page || !id) {
      errors.push(`AHOPs WordPress-post ${index + 1} mangler et stabilt numerisk side-ID`);
      return;
    }
    if (!PAGE_SPECS_BY_ID.has(id)) {
      unexpectedIds.add(id);
      return;
    }
    if (pages.has(id)) {
      errors.push(`AHOP returnerede den allowlistede side ${id} flere gange`);
      return;
    }
    pages.set(id, page);
  });
  if (unexpectedIds.size > 0) {
    warnings.push(
      `${unexpectedIds.size} ikke-allowlistet AHOP-side blev udeladt uden at læse dens indhold`,
    );
  }

  const missingIds = AHOP_PAGE_IDS.filter((id) => !pages.has(id));
  if (missingIds.length > 0) {
    errors.push(`AHOP mangler allowlistede side-ID'er: ${missingIds.join(", ")}`);
  }

  const parsedCandidates: NormalizedEventDraft[] = [];
  for (const spec of PAGE_SPECS) {
    const page = pages.get(spec.id);
    if (!page) continue;
    const parsed = parsePage(page, spec, errors);
    if (parsed) parsedCandidates.push(candidateFromPage(parsed, spec, retrievedAt, warnings));
  }
  const uniqueErrors = [...new Set(errors)];
  return {
    candidates: uniqueErrors.length === 0 ? parsedCandidates : [],
    warnings: [...new Set(warnings)],
    errors: uniqueErrors,
    discardedCandidateCount: uniqueErrors.length === 0 ? 0 : parsedCandidates.length,
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const value = await fetchJson(context, AHOP_API_URL, {
      expectedOrigin: SOURCE_ORIGIN,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    const parsed = parseAhopPages(value, retrievedAt);
    if (parsed.errors.length > 0) {
      return {
        status: "partial",
        source: definition,
        retrievedAt,
        pagesFetched: 1,
        candidates: [],
        errors: parsed.errors,
        warnings: parsed.warnings,
        discardedCandidateCount: parsed.discardedCandidateCount,
      };
    }
    return {
      status: "complete",
      source: definition,
      retrievedAt,
      pagesFetched: 1,
      candidates: parsed.candidates,
      snapshotCoverage: "authoritative",
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

export const ahopSource: SourceAdapter = { definition, collect };
