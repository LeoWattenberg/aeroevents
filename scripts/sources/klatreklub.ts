import { load } from "cheerio";

import { monthlyNthWeekdaySchedule, normalizedTime, weeklySchedule } from "./fixed-schedule";
import { errorMessage, fetchText } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type { CollectionContext, CollectionResult, NormalizedEventDraft, SourceAdapter } from "./types";

const definition = SOURCE_REGISTRY["aeroe-klatreklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const REVIEW_REASON = "Kildesiden angiver ingen sæson- eller feriegrænser; gentagelsesreglen skal kontrolleres før publicering";

interface Rule {
  id: string;
  title: string;
  weekday: number;
  ordinal?: number;
  startTime: string;
  endTime: string;
}

export interface KlatreklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

function timeRange(match: RegExpMatchArray | null): { startTime?: string; endTime?: string } {
  if (!match?.[1] || !match[3]) return {};
  const startTime = normalizedTime(match[1], match[2] ?? "00");
  const endTime = normalizedTime(match[3], match[4] ?? "00");
  return { ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}) };
}

export function parseKlatreklubPage(
  html: string,
  retrievedAt: string,
): KlatreklubParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const title = cleanText($("title#ctl00_ContentPlaceHoldermeta_PageTitle").text());
  const roots = $("#ctl00_ContentPlaceHolderBody_lblPageContent");
  if (title !== "Ærø Klatreklub" || roots.length !== 1) {
    return { candidates: [], warnings, errors: ["Ærø Klatreklubs sideidentitet eller aktivitetsblok mangler"] };
  }
  const text = cleanText(roots.text());
  if (!/Klatrevæg:/i.test(text) || !/KVIK Søbys idrætshal/i.test(text) || !/Åbningstider:/i.test(text)) {
    return { candidates: [], warnings, errors: ["Ærø Klatreklubs forventede åbningstidsmarkører mangler"] };
  }

  const mondayKids = timeRange(text.match(/Mandag:\s*Kids club\s+kl\.?\s*(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/i));
  const mondayFree = timeRange(text.match(/Mandag:[\s\S]*?Fri klatring\s+kl\.?\s*(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/i));
  const wednesdayFree = timeRange(text.match(/Onsdag:\s*Fri klatring\s+kl\.?\s*(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/i));
  const monthlyFree = timeRange(text.match(/Anden søndag i måneden:\s*Fri klatring\s+kl\.?\s*(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/i));
  const specs = [
    ["monday-kids-club", "Kids club", 1, undefined, mondayKids],
    ["monday-free-climbing", "Fri klatring – mandag", 1, undefined, mondayFree],
    ["wednesday-free-climbing", "Fri klatring – onsdag", 3, undefined, wednesdayFree],
    ["second-sunday-free-climbing", "Fri klatring – anden søndag", 7, 2, monthlyFree],
  ] as const;
  const rules: Rule[] = [];
  for (const [id, ruleTitle, weekday, ordinal, times] of specs) {
    if (!times.startTime || !times.endTime || times.endTime <= times.startTime) {
      errors.push(`Ærø Klatreklubs regel “${ruleTitle}” har et ugyldigt eller manglende tidsinterval`);
    } else {
      rules.push({ id, title: ruleTitle, weekday, ...(ordinal ? { ordinal } : {}), startTime: times.startTime, endTime: times.endTime });
    }
  }
  if (errors.length > 0) return { candidates: [], warnings, errors };

  const candidates = rules.map((rule): NormalizedEventDraft => ({
    sourceId: definition.id,
    sourceEventId: rule.id,
    stableId: `${definition.id}-${rule.id}`,
    title: rule.title,
    description: "Fast klatreaktivitet ifølge klubbens offentlige åbningstider. Kontrollér klubbens Facebook-feed for ændringer og undtagelser.",
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: {
      name: "KVIK Søby Idrætshal",
      address: "Vitsø 1",
      postalCode: "5985",
      city: "Søby Ærø",
    },
    schedule: rule.ordinal
      ? monthlyNthWeekdaySchedule(rule.weekday, rule.ordinal, rule.startTime, rule.endTime)
      : weeklySchedule(rule.weekday, rule.startTime, rule.endTime),
    occurrences: [],
    status: "scheduled",
    attendance: "unknown",
    attendanceDetails: "Klubben oplyser ikke på siden, om ikke-medlemmer kan deltage.",
    publication: "review",
    reviewReasons: [REVIEW_REASON, "Adgang for ikke-medlemmer skal bekræftes"],
    provenance: {
      sourceId: definition.id,
      externalId: rule.id,
      sourceUrl: definition.url,
      retrievedAt,
    },
  }));
  return { candidates, warnings, errors };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseKlatreklubPage(html, retrievedAt);
    if (parsed.errors.length > 0) {
      return {
        status: "partial", source: definition, retrievedAt, pagesFetched: 1,
        candidates: [], errors: parsed.errors, warnings: parsed.warnings,
        discardedCandidateCount: 0,
      };
    }
    return {
      status: "complete", source: definition, retrievedAt, pagesFetched: 1,
      candidates: parsed.candidates, errors: [], warnings: parsed.warnings,
    };
  } catch (error) {
    return { status: "failed", source: definition, retrievedAt, pagesFetched: 0, candidates: [], errors: [errorMessage(error)], warnings: [] };
  }
}

export const klatreklubSource: SourceAdapter = { definition, collect };
