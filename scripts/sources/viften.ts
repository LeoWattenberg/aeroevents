import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { absoluteUrl, cleanText, deduplicateBy, isoDate, validCalendarDate } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY.viften;
const VIFTEN_ORIGIN = new URL(definition.url).origin;

export interface ViftenListingItem {
  id: string;
  title: string;
  url: string;
}

export interface ViftenListingResult {
  items: ViftenListingItem[];
  warnings: string[];
  errors: string[];
}

export interface ViftenDetailResult {
  candidate?: NormalizedEventDraft;
  warnings: string[];
  errors: string[];
}

function subjectClassId(url: string): string | undefined {
  return new URL(url).pathname.match(/\/subjectclass\/([a-f0-9]{32})(?:\/|$)/i)?.[1]?.toLowerCase();
}

function infoValue(
  $: ReturnType<typeof load>,
  labelId: string,
): string {
  const group = $(`.enrollment-subjectclass-info-container .enrollment-info[aria-labelledby~='${labelId}']`).first();
  if (group.length === 0) return "";
  const clone = group.clone();
  clone.find(".sr-only, .enrollment-info-icon").remove();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

function parseClock(value: string): string | undefined {
  const match = value.match(/\bkl\.?\s*(\d{1,2})(?:[.:](\d{2}))?/i);
  if (!match?.[1]) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function resolveEventDate(
  value: string,
  deadline: DateTime | undefined,
  retrievedAt: string,
): { date?: string; inferredFrom?: "deadline" | "retrieval" } {
  const match = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (!match?.[1] || !match[2]) return {};
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (match[3]) {
    const year = Number(match[3]);
    return validCalendarDate(year, month, day) ? { date: isoDate(year, month, day) } : {};
  }

  if (deadline?.isValid) {
    let year = deadline.year;
    const candidate = isoDate(year, month, day);
    if (candidate < deadline.toISODate()!) year += 1;
    return validCalendarDate(year, month, day)
      ? { date: isoDate(year, month, day), inferredFrom: "deadline" }
      : {};
  }
  const retrieved = DateTime.fromISO(retrievedAt, { setZone: true }).setZone("Europe/Copenhagen");
  if (!retrieved.isValid) return {};
  let year = retrieved.year;
  const candidate = isoDate(year, month, day);
  if (candidate < retrieved.toISODate()!) year += 1;
  return validCalendarDate(year, month, day)
    ? { date: isoDate(year, month, day), inferredFrom: "retrieval" }
    : {};
}

function meetingLocation(value: string): EventLocationDraft | undefined {
  const city = value.match(/(Ærøskøbing|Marstal|Søby)/i)?.[1];
  const meetingName = value.match(/(?:^|\s)ved\s+(.+?)(?:\s+i\s+(?:Ærøskøbing|Marstal|Søby)|\s*$|\n)/i)?.[1];
  if (!city && !meetingName) return undefined;
  return {
    ...(meetingName ? { name: cleanText(meetingName) } : {}),
    ...(city ? { city } : {}),
  };
}

function descriptionFromPage($: ReturnType<typeof load>): string {
  const section = $("#subjectclass-description-d").first().length > 0
    ? $("#subjectclass-description-d").first()
    : $("#subjectclass-description").first();
  const clone = section.clone();
  clone.find("h3, button").remove();
  clone.find("br").replaceWith("\n");
  return clone
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(cleanText)
    .filter(Boolean)
    .join("\n");
}

export function parseViftenListing(
  html: string,
  pageUrl = definition.url,
): ViftenListingResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const items: ViftenListingItem[] = [];
  const sections = $(".class-display-section").filter((_index, element) =>
    cleanText($(element).find(".carousel-header .section-title").first().text())
      .toLocaleLowerCase("da-DK") === "aktuelle ture og begivenheder"
  );
  if (sections.length !== 1) {
    errors.push(
      sections.length === 0
        ? "Viftens side mangler sektionen Aktuelle ture og begivenheder"
        : "Viftens side indeholder flere aktuelle-sektioner end forventet",
    );
    return { items, warnings, errors };
  }

  sections.first().find(".subjectclass-card").each((index, element) => {
    const card = $(element);
    const idAttribute = cleanText(card.attr("id") ?? "").replace(/^subjectclass-/i, "").toLowerCase();
    const anchor = card.find("a[href*='/subjectclass/']").first();
    const title = cleanText(card.find(".card-body-title").first().text());
    const href = anchor.attr("href");
    if (!href || !title) {
      errors.push(`Viftens kort ${index + 1} mangler link eller titel`);
      return;
    }
    try {
      const url = sameOriginHttpsUrl(absoluteUrl(href, pageUrl), VIFTEN_ORIGIN);
      const id = subjectClassId(url);
      if (!id || idAttribute !== id) {
        errors.push(`Viftens kort ${index + 1} har modstridende eller manglende GUID`);
        return;
      }
      items.push({ id, title, url });
    } catch (error) {
      errors.push(`Viftens kort ${index + 1} har et usikkert link: ${errorMessage(error)}`);
    }
  });

  const unique = deduplicateBy(items, (item) => item.id);
  if (unique.length !== items.length) errors.push("Viften returnerede samme GUID flere gange");
  return { items: unique, warnings, errors };
}

export function parseViftenDetail(
  html: string,
  sourceUrl: string,
  retrievedAt: string,
): ViftenDetailResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const pages = $("main .enrollment-page");
  const sourceEventId = subjectClassId(sourceUrl);
  const formId = cleanText($("input[name='subjectclass_guid']").first().attr("value") ?? "").toLowerCase();
  const title = cleanText($("h1.subjectclass-details-title").first().text());
  if (pages.length !== 1) errors.push("Viftens detaljeside mangler den forventede tilmeldingsside");
  if (!sourceEventId) errors.push("Viftens detalje-URL mangler en gyldig GUID");
  if (!title) errors.push("Viftens detaljeside mangler titel");
  if (sourceEventId && formId && sourceEventId !== formId) {
    errors.push("Viftens GUID er forskellig i URL og tilmeldingsformular");
  }

  const statusElement = $(".enrollment-seat-waitlist-status").first();
  const rawDeadline = infoValue($, "lesson-deadline-label");
  const deadline = rawDeadline
    ? DateTime.fromISO(rawDeadline, { zone: "Europe/Copenhagen" })
    : undefined;
  if (rawDeadline && !deadline?.isValid) {
    errors.push("Viftens tilmeldingsfrist er ikke et gyldigt ISO-tidspunkt");
  }
  const eventInfo = infoValue($, "next-lesson-timeplace-label");
  const hiddenStart = statusElement.attr("data-next-lesson-date");
  let eventDate: string | undefined;
  let startTime: string | undefined;
  let inferredFrom: "deadline" | "retrieval" | undefined;
  if (hiddenStart) {
    const parsed = DateTime.fromISO(hiddenStart, { setZone: true }).setZone("Europe/Copenhagen");
    if (parsed.isValid) {
      eventDate = parsed.toISODate() ?? undefined;
      startTime = parsed.toFormat("HH:mm");
    }
  }
  if (!eventDate) {
    const resolved = resolveEventDate(eventInfo, deadline?.isValid ? deadline : undefined, retrievedAt);
    eventDate = resolved.date;
    inferredFrom = resolved.inferredFrom;
  }
  const clocks = [...eventInfo.matchAll(/\bkl\.?\s*(\d{1,2})(?:[.:](\d{2}))?/gi)]
    .map((match) => parseClock(match[0]))
    .filter((value): value is string => value !== undefined);
  startTime ??= clocks[0];
  const endTime = clocks.length > 1 ? clocks.at(-1) : undefined;
  if (!eventInfo) errors.push("Viftens detaljeside mangler dato- og afgangsfeltet");
  if (!eventDate) errors.push("Viftens detaljeside mangler en gyldig eventdato");
  if (errors.length > 0 || !sourceEventId || !title || !eventDate) {
    return { warnings, errors };
  }

  const description = descriptionFromPage($);
  const attendanceDetails = infoValue($, "lesson-restriction-label");
  const price = infoValue($, "lesson-price-label");
  const location = meetingLocation(eventInfo);
  const form = $("form#enrollment-form");
  const bookingRequired = form.length === 1 || $("a[href='#enrollment']").length > 0;
  const bookingUrl = bookingRequired ? `${sourceUrl.replace(/#.*$/, "")}#enrollment` : undefined;
  const bookingDetails = deadline?.isValid
    ? `Tilmeldingsfrist ${deadline.setLocale("da").toFormat("d. MMMM yyyy 'kl.' HH.mm")}`
    : undefined;
  const visibleStatus = cleanText(
    `${title} ${$("#enrollment-status-container, .enrollment-seat-waitlist-status").text()}`,
  );
  const cancelled = /\baflyst\b/i.test(visibleStatus);
  const postponed = !cancelled && /\b(?:udskudt|udsat|flyttet)\b/i.test(visibleStatus);
  const soldOut = /\b(?:udsolgt|fuldt booket|venteliste)\b/i.test(visibleStatus);
  const isEnrollable = statusElement.attr("data-is-enrollable");
  const reviewReasons: string[] = [];
  if (inferredFrom === "deadline") {
    reviewReasons.push("Eventens årstal er udledt af den eksplicitte tilmeldingsfrist");
  } else if (inferredFrom === "retrieval") {
    reviewReasons.push("Eventens årstal er udledt af indsamlingstidspunktet");
  }
  if (!startTime) reviewReasons.push("Viften oplyser ikke et sikkert starttidspunkt");
  if (!attendanceDetails) reviewReasons.push("Viften oplyser ikke klassetrin eller aldersgruppe");
  if (!location) reviewReasons.push("Viftens afgangssted kunne ikke struktureres sikkert");
  if (deadline?.isValid && eventDate < deadline.toISODate()!) {
    reviewReasons.push("Eventdatoen ligger før tilmeldingsfristen på kildesiden");
  }

  let endDate = eventDate;
  if (endTime && /\b(?:næste|dagen efter|følgende)\s+dag\b/i.test(eventInfo)) {
    endDate = DateTime.fromISO(eventDate).plus({ days: 1 }).toISODate()!;
  }
  return {
    warnings,
    errors,
    candidate: {
      sourceId: definition.id,
      sourceEventId,
      stableId: `${definition.id}-${sourceEventId}`,
      title,
      ...(description ? { description } : {}),
      organizerId: definition.organizerId,
      categoryIds: [...definition.categoryIds],
      ...(location ? { location } : {}),
      occurrences: [{
        id: `viften-${sourceEventId}`,
        date: eventDate,
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endDate, endTime } : {}),
        allDay: false,
        timeUnknown: startTime === undefined,
      }],
      status: cancelled ? "cancelled" : postponed ? "postponed" : "scheduled",
      availability: soldOut ? "sold-out" : isEnrollable === "true" ? "available" : "unknown",
      attendance: bookingRequired ? "registration" : "public",
      ...(attendanceDetails ? { attendanceDetails } : {}),
      ...(price ? { price } : {}),
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(bookingRequired ? { bookingRequired: true } : {}),
      ...(bookingDetails ? { bookingDetails } : {}),
      publication: reviewReasons.length > 0 ? "review" : "trusted",
      reviewReasons,
      provenance: {
        sourceId: definition.id,
        externalId: sourceEventId,
        sourceUrl,
        retrievedAt,
      },
    },
  };
}

async function collect(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  let pagesFetched = 0;
  try {
    const listingHtml = await fetchText(context, definition.url, {
      expectedOrigin: VIFTEN_ORIGIN,
    });
    pagesFetched += 1;
    const listing = parseViftenListing(listingHtml, definition.url);
    warnings.push(...listing.warnings);
    errors.push(...listing.errors);
    if (listing.items.length === 0) {
      errors.push("Viften returnerede ingen aktuelle ture eller begivenheder; snapshot beholdes");
    }
    if (errors.length === 0) {
      for (const item of listing.items) {
        try {
          const detailHtml = await fetchText(context, item.url, {
            expectedOrigin: VIFTEN_ORIGIN,
          });
          pagesFetched += 1;
          const detail = parseViftenDetail(detailHtml, item.url, retrievedAt);
          warnings.push(...detail.warnings);
          errors.push(...detail.errors.map((message) => `${item.url}: ${message}`));
          if (detail.candidate) {
            if (
              detail.candidate.title.toLocaleLowerCase("da-DK") !==
              item.title.toLocaleLowerCase("da-DK")
            ) {
              const reason = "Titlen på Viftens liste og detaljeside er forskellig";
              warnings.push(`${item.url}: ${reason}`);
              detail.candidate.publication = "review";
              detail.candidate.reviewReasons.push(reason);
            }
            candidates.push(detail.candidate);
          }
        } catch (error) {
          errors.push(`${item.url}: ${errorMessage(error)}`);
        }
      }
    }
  } catch (error) {
    if (pagesFetched === 0) {
      return {
        status: "failed",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        errors: [errorMessage(error)],
        warnings,
      };
    }
    errors.push(errorMessage(error));
  }

  const ids = candidates.map((candidate) => candidate.sourceEventId);
  if (new Set(ids).size !== ids.length) errors.push("Viften returnerede samme GUID flere gange");
  if (errors.length > 0) {
    return {
      status: "partial",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
      discardedCandidateCount: candidates.length,
    };
  }
  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates,
    errors: [],
    warnings: [...new Set(warnings)],
  };
}

export const viftenSource: SourceAdapter = { definition, collect };
