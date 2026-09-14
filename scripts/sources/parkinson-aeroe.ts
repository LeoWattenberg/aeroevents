import { load } from "cheerio";

import { monthlyNthWeekdayOccurrences, normalizedTime } from "./fixed-schedule";
import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type { CollectionContext, CollectionResult, NormalizedEventDraft, SourceAdapter } from "./types";

const definition = SOURCE_REGISTRY["parkinsonforeningen-aeroe"];
const SOURCE_ORIGIN = new URL(definition.url).origin;
const REVIEW_REASON = "Den månedlige regel angiver ikke aflysninger, ferier eller en slutdato; de beregnede datoer skal kontrolleres før publicering";

export interface ParkinsonAeroeParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

export function parseParkinsonAeroePage(
  html: string,
  retrievedAt: string,
  now: Date,
): ParkinsonAeroeParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const canonical = $("link[rel='canonical']").attr("href");
  try {
    if (!canonical || sameOriginHttpsUrl(canonical, SOURCE_ORIGIN) !== definition.url) {
      errors.push("Parkinsonforeningens canonical-link matcher ikke Fynskredsens klubside");
    }
  } catch {
    errors.push("Parkinsonforeningens canonical-link er usikkert");
  }
  const clubs = $("article.club-info").filter((_index, element) =>
    cleanText($(element).find("h2.club-name").first().text()) === "Klub Ærø"
  );
  if (clubs.length !== 1) errors.push(`Parkinsonforeningens klubside indeholder ${clubs.length} entydige Klub Ærø-poster`);
  const club = clubs.first();
  const id = club.attr("id")?.match(/^post-(\d+)$/)?.[1];
  const popup = club.next(".popup-infor-2021");
  if (!id || popup.length !== 1 || cleanText(popup.find("h2.club-name").first().text()) !== "Klub Ærø") {
    errors.push("Parkinsonforeningens stabile Klub Ærø-ID eller tilhørende infoblok mangler");
  }
  if (errors.length > 0 || !id) return { candidates: [], warnings, errors };

  const text = cleanText(popup.find(".popup-infor-content-2021").text());
  const rule = text.match(/Vi mødes\s+(?:den\s+)?1\.\s*tirsdag\s+i\s+Rise Beboerhus,?\s*Store Rise Landevej 13,\s*5970\s+Ærøskøbing/i);
  const times = text.match(/Mødet starter\s+kl\.?\s*(\d{1,2})[.:](\d{2})\s*,?\s*og varer til ca\.?\s*(\d{1,2})[.:](\d{2})/i);
  const startTime = times?.[1] ? normalizedTime(times[1], times[2]) : undefined;
  const endTime = times?.[3] ? normalizedTime(times[3], times[4]) : undefined;
  if (!rule || !startTime || !endTime || endTime <= startTime) {
    return { candidates: [], warnings, errors: ["Klub Ærøs månedlige møderegel, sted eller tidsinterval mangler"] };
  }
  const sourceEventId = `club-${id}-monthly-meeting`;
  const candidate: NormalizedEventDraft = {
    sourceId: definition.id,
    sourceEventId,
    stableId: `${definition.id}-${sourceEventId}`,
    title: "Klub Ærø – månedligt møde",
    description: "Klubmøde med sang, bevægelse, samtale og kaffe.",
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    location: {
      name: "Rise Beboerhus",
      address: "Store Rise Landevej 13",
      postalCode: "5970",
      city: "Ærøskøbing",
    },
    occurrences: monthlyNthWeekdayOccurrences(sourceEventId, 2, 1, startTime, endTime, now),
    status: "scheduled",
    attendance: "members",
    attendanceDetails: "Aktivitet i Parkinsonforeningens Klub Ærø; alle foreningens medlemmer kan deltage i kredsens klubaktiviteter.",
    publication: "review",
    reviewReasons: [REVIEW_REASON],
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl: definition.url,
      retrievedAt,
    },
  };
  return { candidates: [candidate], warnings, errors };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  try {
    const html = await fetchText(context, definition.url, { expectedOrigin: SOURCE_ORIGIN });
    const parsed = parseParkinsonAeroePage(html, retrievedAt, context.now);
    if (parsed.errors.length > 0) {
      return { status: "partial", source: definition, retrievedAt, pagesFetched: 1, candidates: [], errors: parsed.errors, warnings: parsed.warnings, discardedCandidateCount: 0 };
    }
    return { status: "complete", source: definition, retrievedAt, pagesFetched: 1, candidates: parsed.candidates, errors: [], warnings: parsed.warnings };
  } catch (error) {
    return { status: "failed", source: definition, retrievedAt, pagesFetched: 0, candidates: [], errors: [errorMessage(error)], warnings: [] };
  }
}

export const parkinsonAeroeSource: SourceAdapter = { definition, collect };
