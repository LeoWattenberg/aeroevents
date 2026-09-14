import { load } from "cheerio";

import { normalizedTime, weeklyOccurrences } from "./fixed-schedule";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type { CollectionContext, CollectionResult, NormalizedEventDraft, SourceAdapter } from "./types";

const definition = SOURCE_REGISTRY["aeroe-tennisklub"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const REVIEW_REASON = "Kildesiden angiver ikke sæsonens slutdato eller ferieundtagelser; de beregnede datoer skal kontrolleres før publicering";

interface TennisRule {
  id: string;
  title: string;
  weekday: number;
  startTime: string;
  endTime: string;
  registration: boolean;
  description: string;
}

export interface TennisklubParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

function parseTimes(value: string): { startTime?: string; endTime?: string } {
  const match = value.match(/(?:fra\s+kl\.?\s*)?(\d{1,2})(?:[.:](\d{2}))?\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?/i);
  if (!match?.[1] || !match[3]) return {};
  const startTime = normalizedTime(match[1], match[2] ?? "00");
  const endTime = normalizedTime(match[3], match[4] ?? "00");
  return { ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}) };
}

export function parseTennisklubPage(
  html: string,
  retrievedAt: string,
  now: Date,
): TennisklubParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const canonical = $("link[rel='canonical']").attr("href");
  try {
    if (!canonical || sameOriginHttpsUrl(canonical, SOURCE_ORIGIN) !== definition.url) {
      errors.push("Ærø Tennisklubs canonical-link matcher ikke aktivitetssiden");
    }
  } catch {
    errors.push("Ærø Tennisklubs canonical-link er usikkert");
  }
  if (!$("body").hasClass("page-id-22")) errors.push("Ærø Tennisklubs stabile WordPress-side-ID 22 mangler");
  const roots = $(".sm-text-image-3-wrapper").filter((_index, element) =>
    cleanText($(element).children("h3").first().text()) === "Faste aktiviteter i sæsonen"
  );
  if (roots.length !== 1) errors.push("Ærø Tennisklubs blok med faste sæsonaktiviteter mangler");
  if (errors.length > 0) return { candidates: [], warnings, errors };

  const expected = [
    { id: "monday-coffee-tennis", title: "Kaffetennis", weekday: 1, marker: /Kaffetennis/i, registration: false },
    { id: "monday-tennis-for-all", title: "Tennis for alle", weekday: 1, marker: /Tennis for alle/i, registration: false },
    { id: "wednesday-drop-in", title: "Drop-in tennis", weekday: 3, marker: /Drop-in/i, registration: false },
    { id: "thursday-after-work-tennis", title: "Fyraftenstennis", weekday: 4, marker: /Fyraftenstennis/i, registration: false },
    { id: "sunday-ball-machine", title: "Slagtræning med boldmaskine", weekday: 7, marker: /Slagtræning med boldmaskine/i, registration: true },
  ] as const;
  const lines = roots.find(".sm-text-image-3-content > h3").toArray().map((element) => cleanText($(element).text()));
  const rules: TennisRule[] = [];
  for (const spec of expected) {
    const matching = lines.filter((line) => spec.marker.test(line));
    if (matching.length !== 1) {
      errors.push(`Ærø Tennisklubs regel “${spec.title}” forekommer ${matching.length} gange`);
      continue;
    }
    const times = parseTimes(matching[0]!);
    if (!times.startTime || !times.endTime || times.endTime <= times.startTime) {
      errors.push(`Ærø Tennisklubs regel “${spec.title}” har et ugyldigt tidsinterval`);
      continue;
    }
    const safeDescription = matching[0]!
      .replace(/\s+hos\s+[\s\S]*$/i, "")
      .replace(/\b\d{2}(?:\s*\d{2}){3}\b[\s\S]*$/i, "");
    rules.push({ ...spec, startTime: times.startTime, endTime: times.endTime, description: safeDescription });
  }
  if (errors.length > 0) return { candidates: [], warnings, errors };

  const candidates = rules.map((rule): NormalizedEventDraft => ({
    sourceId: definition.id,
    sourceEventId: `page-22-${rule.id}`,
    stableId: `${definition.id}-${rule.id}`,
    title: rule.title,
    description: rule.description,
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: { name: "Ærø Tennisklub", address: "Pilebækken 14", city: "Ærøskøbing" },
    occurrences: weeklyOccurrences(rule.id, rule.weekday, rule.startTime, rule.endTime, now),
    status: "scheduled",
    attendance: rule.registration ? "registration" : "unknown",
    attendanceDetails: rule.registration
      ? "Fire deltagere pr. time; tilmelding efter først-til-mølle-princippet."
      : "Klubben oplyser ikke på siden, om ikke-medlemmer kan deltage.",
    ...(rule.registration
      ? { bookingRequired: true, bookingDetails: "Se kildesiden for den aktuelle kontaktperson; telefonnummer gemmes ikke i kalenderdata." }
      : {}),
    publication: "review",
    reviewReasons: [REVIEW_REASON, ...(rule.registration ? [] : ["Adgang for ikke-medlemmer skal bekræftes"])],
    provenance: {
      sourceId: definition.id,
      externalId: `page-22-${rule.id}`,
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
    const parsed = parseTennisklubPage(html, retrievedAt, context.now);
    if (parsed.errors.length > 0) {
      return { status: "partial", source: definition, retrievedAt, pagesFetched: 1, candidates: [], errors: parsed.errors, warnings: parsed.warnings, discardedCandidateCount: 0 };
    }
    return { status: "complete", source: definition, retrievedAt, pagesFetched: 1, candidates: parsed.candidates, errors: [], warnings: parsed.warnings };
  } catch (error) {
    return { status: "failed", source: definition, retrievedAt, pagesFetched: 0, candidates: [], errors: [errorMessage(error)], warnings: [] };
  }
}

export const tennisklubSource: SourceAdapter = { definition, collect };
