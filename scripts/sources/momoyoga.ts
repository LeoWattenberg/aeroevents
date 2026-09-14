import { load } from "cheerio";
import { DateTime } from "luxon";

import { errorMessage, fetchText, sameOriginHttpsUrl } from "./http";
import { cleanText } from "./html";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  EventLocationDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["ritual-momoyoga"];
const COPENHAGEN = "Europe/Copenhagen";
const MOMOYOGA_ORIGIN = new URL(definition.url).origin;
const PROFILE = "nurtureaeroe";
const MAX_WEEKS = 55;

/** Individual massage/facial slots share the schedule and must never pass this allowlist. */
export const MOMOYOGA_ALLOWED_TITLES = new Set(["flow yoga"]);

export interface MomoyogaScheduleParseResult {
  weekStart?: string;
  candidates: NormalizedEventDraft[];
  observedLessonDates: string[];
  listedLessonCount: number;
  excludedLessonCount: number;
  warnings: string[];
  errors: string[];
}

interface ParsedLesson {
  id: string;
  title: string;
  detailUrl: string;
  description?: string;
  start: DateTime;
  end: DateTime;
  cancelled: boolean;
  soldOut: boolean;
  isFree: boolean;
  bookingRequired: boolean;
  bookingDetails?: string;
  location?: EventLocationDraft;
  modifiedAt?: string;
  projection: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && cleanText(value) ? cleanText(value) : undefined;
}

function descriptionText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const result = value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join("\n");
  return result || undefined;
}

function lessonId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function zonedInstant(value: unknown): DateTime | undefined {
  if (typeof value !== "string" || !/(?:z|[+-]\d{2}:?\d{2})$/iu.test(value)) {
    return undefined;
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.setZone(COPENHAGEN) : undefined;
}

function stateText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      const state = record(item);
      return [state?.name, state?.label, state?.title].filter(
        (candidate): candidate is string => typeof candidate === "string",
      );
    })
    .join(" ");
}

function spots(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function structuredLocation(value: unknown): EventLocationDraft | undefined {
  if (typeof value === "string" && cleanText(value)) return { name: cleanText(value) };
  const item = record(value);
  if (!item) return undefined;
  const name = text(item.name ?? item.title);
  const addressValue = item.address;
  const addressObject = record(addressValue);
  const address = text(
    typeof addressValue === "string"
      ? addressValue
      : addressObject?.address ?? addressObject?.street ?? addressObject?.streetName,
  );
  const postalCode = text(addressObject?.postalCode ?? addressObject?.zip);
  const city = text(addressObject?.city);
  const location: EventLocationDraft = {};
  if (name) location.name = name;
  if (address) location.address = address;
  if (postalCode) location.postalCode = postalCode;
  if (city) location.city = city;
  return Object.keys(location).length > 0 ? location : undefined;
}

function locationFromDescription(description: string | undefined): EventLocationDraft | undefined {
  if (!description) return undefined;
  const lines = description.split("\n");
  const marker = lines.findIndex((line) => /^(?:location|sted|adresse)$/iu.test(line));
  const address = marker >= 0 ? lines.slice(marker + 1).find((line) => line.length <= 200) : undefined;
  if (!address) return undefined;
  const location: EventLocationDraft = {
    name: "Ritual – Ærø",
    address,
  };
  const postal = address.match(/\b(59\d{2})\s+(.+)$/u);
  if (postal?.[1] && postal[2]) {
    location.postalCode = postal[1];
    location.city = cleanText(postal[2]);
  }
  return location;
}

function locationForLesson(lesson: Record<string, unknown>, description?: string): EventLocationDraft | undefined {
  const heldAt = structuredLocation(lesson.heldAt);
  const location = structuredLocation(lesson.location);
  const room = structuredLocation(lesson.room);
  const selected = heldAt ?? location ?? room ?? locationFromDescription(description);
  if (!selected) return undefined;
  if (!selected.name && room?.name) selected.name = room.name;
  if (!selected.name) selected.name = "Ritual – Ærø";
  return selected;
}

function parseLesson(value: unknown): { lesson?: ParsedLesson; errors: string[] } {
  const errors: string[] = [];
  const options = record(value);
  const lesson = record(options?.lesson);
  if (!lesson) return { errors: ["Momoyoga-komponenten mangler lesson-data"] };
  const id = lessonId(lesson.id);
  const title = text(lesson.title);
  const start = zonedInstant(lesson.timeFrom ?? lesson.fromTime);
  const end = zonedInstant(lesson.timeTo);
  let detailUrl: string | undefined;
  try {
    if (typeof lesson.detailUrl === "string") {
      detailUrl = sameOriginHttpsUrl(lesson.detailUrl, MOMOYOGA_ORIGIN);
    }
  } catch {
    // Reported uniformly below.
  }
  if (!id) errors.push("Momoyoga-lektionen mangler et stabilt numerisk id");
  if (!title) errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler titel`);
  if (!start) errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler starttid med offset`);
  if (!end) errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler sluttid med offset`);
  if (start && end && end <= start) {
    errors.push(`Momoyoga-lektion ${id ?? "ukendt"} slutter før eller samtidig med start`);
  }
  if (!detailUrl || (id && !new URL(detailUrl).pathname.startsWith(`/${PROFILE}/lesson/${id}/`))) {
    errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler et sikkert detaljelink`);
  }
  if (typeof lesson.isCancelled !== "boolean") {
    errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler aflysningsstatus`);
  }
  for (const field of ["isBookable", "requiresOrderToBook", "isFree"] as const) {
    if (typeof lesson[field] !== "boolean") {
      errors.push(`Momoyoga-lektion ${id ?? "ukendt"} mangler ${field}`);
    }
  }
  const profileName = text(options?.profileName);
  if (profileName && profileName !== PROFILE) {
    errors.push(`Momoyoga-lektion ${id ?? "ukendt"} tilhører en anden profil`);
  }
  if (errors.length > 0 || !id || !title || !start || !end || !detailUrl) {
    return { errors };
  }

  const total = spots(lesson.spotsTotal);
  const open = spots(lesson.spotsOpen);
  if ((lesson.spotsTotal !== undefined && total === undefined) || (lesson.spotsOpen !== undefined && open === undefined)) {
    errors.push(`Momoyoga-lektion ${id} har ugyldige kapacitetsfelter`);
    return { errors };
  }
  if (total !== undefined && open !== undefined && open > total) {
    errors.push(`Momoyoga-lektion ${id} har flere ledige pladser end pladser i alt`);
    return { errors };
  }
  const states = stateText(lesson.states);
  const soldOut =
    (total !== undefined && total > 0 && open === 0) ||
    /\b(?:sold\s*out|fully\s*booked|udsolgt|venteliste)\b/iu.test(states);
  const description = descriptionText(lesson.description);
  const location = locationForLesson(lesson, description);
  const updatedValue =
    lesson.updated === null || lesson.updated === undefined
      ? undefined
      : zonedInstant(lesson.updated);
  if (lesson.updated !== null && lesson.updated !== undefined && !updatedValue) {
    errors.push(`Momoyoga-lektion ${id} har et ugyldigt ændringstidspunkt`);
    return { errors };
  }
  const updated = updatedValue?.toUTC().toISO() ?? undefined;
  const bookingRequired = lesson.requiresOrderToBook === true || lesson.isBookable === true;
  const bookingDetails =
    total !== undefined && open !== undefined
      ? soldOut
        ? `Ingen ledige pladser ud af ${total}.`
        : `${open} af ${total} pladser er ledige.`
      : undefined;
  const projection = JSON.stringify({
    id,
    title,
    detailUrl,
    description,
    start: start.toISO(),
    end: end.toISO(),
    cancelled: lesson.isCancelled,
    soldOut,
    isFree: lesson.isFree === true,
    bookingRequired,
    bookingDetails,
    location,
    updated,
  });
  return {
    errors,
    lesson: {
      id,
      title,
      detailUrl,
      ...(description ? { description } : {}),
      start,
      end,
      cancelled: lesson.isCancelled === true,
      soldOut,
      isFree: lesson.isFree === true,
      bookingRequired,
      ...(bookingDetails ? { bookingDetails } : {}),
      ...(location ? { location } : {}),
      ...(updated ? { modifiedAt: updated } : {}),
      projection,
    },
  };
}

function selectedWeekStart($: ReturnType<typeof load>): string | undefined {
  const dateTexts = $(".schedule-pagination a.week-change[href*='date=']")
    .map((_index, element) => {
      try {
        return new URL($(element).attr("href")!, definition.url).searchParams.get("date") ?? "";
      } catch {
        return "";
      }
    })
    .get()
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  // Momoyoga renders the same pagination above and below the schedule.
  const dates = [...new Set(dateTexts)]
    .map((value) => DateTime.fromISO(value, { zone: COPENHAGEN }))
    .filter((value) => value.isValid)
    .sort((left, right) => left.toMillis() - right.toMillis());
  if (dates.length !== 2 || dates[1]!.diff(dates[0]!, "days").days !== 14) return undefined;
  return dates[0]!.plus({ days: 7 }).toISODate()!;
}

function draftFromLesson(lesson: ParsedLesson, retrievedAt: string): NormalizedEventDraft {
  return {
    sourceId: definition.id,
    sourceEventId: lesson.id,
    stableId: `${definition.id}-${lesson.id}`,
    title: lesson.title,
    ...(lesson.description ? { description: lesson.description } : {}),
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    ...(lesson.location ? { location: lesson.location } : {}),
    occurrences: [
      {
        id: `momoyoga-${lesson.id}`,
        date: lesson.start.toISODate()!,
        startTime: lesson.start.toFormat("HH:mm"),
        ...(lesson.end.toISODate() !== lesson.start.toISODate()
          ? { endDate: lesson.end.toISODate()! }
          : {}),
        endTime: lesson.end.toFormat("HH:mm"),
        allDay: false,
        timeUnknown: false,
      },
    ],
    status: lesson.cancelled ? "cancelled" : "scheduled",
    ...(lesson.soldOut ? { availability: "sold-out" } : {}),
    attendance: lesson.bookingRequired ? "registration" : "public",
    ...(lesson.bookingRequired ? { attendanceDetails: "Plads bestilles via Momoyoga." } : {}),
    ...(lesson.isFree ? { price: "Gratis" } : {}),
    bookingUrl: lesson.detailUrl,
    bookingRequired: lesson.bookingRequired,
    ...(lesson.bookingDetails ? { bookingDetails: lesson.bookingDetails } : {}),
    publication: "trusted",
    reviewReasons: [],
    provenance: {
      sourceId: definition.id,
      externalId: lesson.id,
      sourceUrl: lesson.detailUrl,
      retrievedAt,
      ...(lesson.modifiedAt ? { sourceModifiedAt: lesson.modifiedAt } : {}),
    },
  };
}

export function parseMomoyogaSchedule(
  html: string,
  retrievedAt: string,
): MomoyogaScheduleParseResult {
  const $ = load(html);
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: NormalizedEventDraft[] = [];
  const observedLessonDates: string[] = [];
  const weekStart = selectedWeekStart($);
  if ($("#schedule").length !== 1 || $(".schedule-day").length < 1) {
    errors.push("Momoyoga-siden mangler den forventede ugeplan");
  }
  if (!weekStart) errors.push("Momoyoga-sidens uge-navigation kunne ikke valideres");

  const lessonRows = $(".schedule-lesson").length;
  const components = $("[data-component='LessonActionButton'][data-options]");
  if (lessonRows > 0 && components.length === 0) {
    errors.push("Momoyoga-siden viser lektioner uden strukturerede lesson-data");
  }

  const lessons = new Map<string, ParsedLesson>();
  components.each((index, element) => {
    const raw = $(element).attr("data-options");
    let value: unknown;
    try {
      value = JSON.parse(raw ?? "");
    } catch {
      errors.push(`Momoyoga-komponent ${index + 1} har ugyldig JSON`);
      return;
    }
    const parsed = parseLesson(value);
    errors.push(...parsed.errors);
    if (!parsed.lesson) return;
    const previous = lessons.get(parsed.lesson.id);
    if (previous && previous.projection !== parsed.lesson.projection) {
      errors.push(`Momoyoga-lektion ${parsed.lesson.id} forekommer med modstridende data`);
      return;
    }
    lessons.set(parsed.lesson.id, previous ?? parsed.lesson);
  });

  let excludedLessonCount = 0;
  for (const lesson of lessons.values()) {
    observedLessonDates.push(lesson.start.toISODate()!);
    if (!MOMOYOGA_ALLOWED_TITLES.has(lesson.title.toLocaleLowerCase("da-DK"))) {
      excludedLessonCount += 1;
      continue;
    }
    candidates.push(draftFromLesson(lesson, retrievedAt));
  }
  if (lessonRows > 0 && lessons.size === 0 && errors.length === 0) {
    errors.push("Momoyoga-sidens lektioner kunne ikke aflæses");
  }
  if (excludedLessonCount > 0) {
    warnings.push(
      `Momoyoga: ${excludedLessonCount} individuelle eller ikke-allowlistede tider blev udeladt`,
    );
  }

  return {
    ...(weekStart ? { weekStart } : {}),
    candidates,
    observedLessonDates: [...new Set(observedLessonDates)].sort(),
    listedLessonCount: lessons.size,
    excludedLessonCount,
    warnings,
    errors: [...new Set(errors)],
  };
}

export function momoyogaScheduleUrl(weekStart: string): string {
  const url = new URL(definition.url);
  url.searchParams.set("date", weekStart);
  url.searchParams.set("_locale_forcing", "da");
  return url.toString();
}

export function momoyogaWeekStarts(now: Date): string[] {
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(COPENHAGEN).startOf("day");
  const end = today.plus({ months: 12 });
  const results: string[] = [];
  for (let week = today.startOf("week"); week <= end; week = week.plus({ weeks: 1 })) {
    results.push(week.toISODate()!);
    if (results.length > MAX_WEEKS) throw new Error("Momoyoga-vinduet oversteg ugegrænsen");
  }
  return results;
}

export async function collectMomoyoga(context: CollectionContext): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates = new Map<string, NormalizedEventDraft>();
  const today = DateTime.fromJSDate(context.now, { zone: "utc" }).setZone(COPENHAGEN).startOf("day");
  const end = today.plus({ months: 12 });
  let pagesFetched = 0;

  try {
    for (const weekStart of momoyogaWeekStarts(context.now)) {
      const html = await fetchText(context, momoyogaScheduleUrl(weekStart), {
        expectedOrigin: MOMOYOGA_ORIGIN,
      });
      pagesFetched += 1;
      const parsed = parseMomoyogaSchedule(html, retrievedAt);
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors);
      if (parsed.weekStart && parsed.weekStart !== weekStart) {
        errors.push(`Momoyoga returnerede ugen ${parsed.weekStart}, forventede ${weekStart}`);
      }
      const week = DateTime.fromISO(weekStart, { zone: COPENHAGEN });
      for (const dateText of parsed.observedLessonDates) {
        const date = DateTime.fromISO(dateText, { zone: COPENHAGEN });
        if (!date.isValid || date < week || date > week.plus({ days: 6 })) {
          errors.push(`Momoyoga-ugen ${weekStart} indeholdt en lektion på ${dateText}`);
        }
      }
      for (const candidate of parsed.candidates) {
        const date = DateTime.fromISO(candidate.occurrences[0]!.date, { zone: COPENHAGEN });
        if (date < today || date > end) continue;
        const previous = candidates.get(candidate.sourceEventId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) {
          errors.push(`Momoyoga-id ${candidate.sourceEventId} ændrede data mellem ugesider`);
          continue;
        }
        candidates.set(candidate.sourceEventId, previous ?? candidate);
      }
      if (parsed.errors.length > 0) break;
    }
  } catch (error) {
    const message = errorMessage(error);
    if (pagesFetched === 0) {
      return {
        status: "failed",
        source: definition,
        retrievedAt,
        pagesFetched,
        candidates: [],
        warnings: [...new Set(warnings)],
        errors: [message],
      };
    }
    errors.push(message);
  }

  if (candidates.size === 0 && errors.length === 0) {
    errors.push("Momoyoga gav ingen allowlistede gruppehold; snapshot beholdes");
  }
  if (errors.length > 0) {
    return {
      status: "partial",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      warnings: [...new Set(warnings)],
      errors: [...new Set(errors)],
      discardedCandidateCount: candidates.size,
    };
  }
  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates: [...candidates.values()].sort((left, right) =>
      left.sourceEventId.localeCompare(right.sourceEventId),
    ),
    warnings: [...new Set(warnings)],
    errors: [],
  };
}

export const momoyogaSource: SourceAdapter = { definition, collect: collectMomoyoga };
