import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { load } from "cheerio";
import { DateTime } from "luxon";

import { cleanText, deduplicateBy } from "./html";
import { errorMessage } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  ExplicitOccurrenceDraft,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY["ommel-samvirke"];
const COPENHAGEN = "Europe/Copenhagen";
const DEFAULT_MONTHS_AHEAD = 12;
const MAX_MONTHS_AHEAD = 18;
const MAX_EVENTS_PER_MONTH = 250;
const MAX_RENDERED_HTML_BYTES = 5 * 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 8_000;
const SOURCE_ORIGIN = "https://www.ommelsamvirke.dk";
const SOURCE_PATH = "/aktivitetskalender";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const DANISH_PHONE_PATTERN =
  /(?<!\d)(?:(?:\+|00)45[\s.-]*)?(?:\d{2}[\s.-]*){3}\d{2}(?!\d)/gu;

const SHORT_MONTHS = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["maj", 5],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["sept", 9],
  ["okt", 10],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

export interface OmmelBrowserSnapshot {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  viewMonth: string;
  html: string;
}

export interface OmmelBrowserClient {
  open(url: string, signal?: AbortSignal): Promise<OmmelBrowserSnapshot>;
  next(signal?: AbortSignal): Promise<OmmelBrowserSnapshot>;
  close(): Promise<void>;
}

export interface OmmelCollectOptions {
  createBrowser?: () => Promise<OmmelBrowserClient>;
  monthsAhead?: number;
}

export interface OmmelCalendarParseResult {
  candidates: NormalizedEventDraft[];
  warnings: string[];
  errors: string[];
}

interface ParsedClock {
  date: string;
  time: string;
}

function assertSourceUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Ommel Samvirke returnerede en ugyldig URL");
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (
    url.protocol !== "https:" ||
    url.origin !== SOURCE_ORIGIN ||
    pathname !== SOURCE_PATH ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Ommel Samvirke-crawleren afviste URL'en ${url.toString()}`);
  }
  return url;
}

function checkedMonthsAhead(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONTHS_AHEAD) {
    throw new Error(`monthsAhead skal være et heltal mellem 0 og ${MAX_MONTHS_AHEAD}`);
  }
  return value;
}

/** Remove public contact details before either parsing or recording a snapshot. */
export function sanitizeOmmelContactText(value: string): string {
  return cleanText(
    value
      .replace(EMAIL_PATTERN, " ")
      .replace(DANISH_PHONE_PATTERN, " ")
      .replace(/\b(?:telefon|tlf\.?|mobil|e-?mail|mail)\s*:\s*(?=$|[.,;])/giu, " "),
  );
}

/**
 * Raw rendered dialogs contain a named coordinator, phone number and email.
 * Those fields are not needed by the public calendar and are removed before
 * the private raw-response recorder sees the HTML as well.
 */
export function sanitizeOmmelRenderedHtml(html: string): string {
  const $ = load(html);
  $("script, style, input, textarea, .event-coordinator").remove();
  $("a[href]").each((_index, anchor) => {
    const href = ($(anchor).attr("href") ?? "").trim().toLocaleLowerCase("en-US");
    if (href.startsWith("mailto:") || href.startsWith("tel:")) {
      $(anchor).closest("p, li, div").remove();
    }
  });
  $("*")
    .contents()
    .each((_index, node) => {
      if (node.type === "text") node.data = sanitizeOmmelContactText(node.data);
    });
  $("*").each((_index, element) => {
    const attributes = "attribs" in element ? Object.keys(element.attribs) : [];
    for (const attribute of attributes) {
      if (attribute === "id" || attribute.startsWith("_bl_")) $(element).removeAttr(attribute);
    }
  });
  return $.html();
}

function parseViewMonth(value: string | undefined): DateTime | undefined {
  if (!value || !/^\d{4}-\d{2}-01$/u.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { zone: COPENHAGEN }).startOf("month");
  return parsed.isValid && parsed.toISODate() === value ? parsed : undefined;
}

function resolveShortDate(raw: string, anchor: DateTime): string | undefined {
  const match = cleanText(raw).match(/^(\d{1,2})\.\s*([\p{L}.]+)$/u);
  if (!match) return undefined;
  const day = Number(match[1]);
  const monthName = match[2]!.replace(/\./gu, "").toLocaleLowerCase("da-DK");
  const month = SHORT_MONTHS.get(monthName);
  if (!month || day < 1 || day > 31) return undefined;

  const candidates = [anchor.year - 1, anchor.year, anchor.year + 1]
    .map((year) => DateTime.fromObject({ year, month, day }, { zone: COPENHAGEN }))
    .filter((date) => date.isValid)
    .sort(
      (left, right) =>
        Math.abs(left.diff(anchor, "days").days) - Math.abs(right.diff(anchor, "days").days),
    );
  const selected = candidates[0];
  if (!selected || Math.abs(selected.diff(anchor, "days").days) > 45) return undefined;
  return selected.toISODate()!;
}

function normalizedTime(value: string): string | undefined {
  const match = cleanText(value).match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/u);
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : undefined;
}

function parseClock(
  values: string[],
  expectedLabel: "Start" | "Slut",
  anchor: DateTime,
): ParsedClock | undefined {
  if (values.length !== 3 || values[0]?.toLocaleLowerCase("da-DK") !== expectedLabel.toLocaleLowerCase("da-DK")) {
    return undefined;
  }
  const date = resolveShortDate(values[1]!, anchor);
  const time = normalizedTime(values[2]!);
  return date && time ? { date, time } : undefined;
}

function parseCreatedDate(value: string): string | undefined {
  const match = cleanText(value).match(/^Oprettet:\s*(.+)$/iu);
  if (!match) return undefined;
  const parsed = DateTime.fromFormat(match[1]!, "d. LLLL yyyy", {
    locale: "da-DK",
    zone: COPENHAGEN,
  });
  return parsed.isValid ? parsed.toISODate()! : undefined;
}

function textList(
  $: ReturnType<typeof load>,
  selector: string,
  root: ReturnType<ReturnType<typeof load>>,
): string[] {
  return root
    .find(selector)
    .toArray()
    .map((element) => cleanText($(element).text()))
    .filter(Boolean);
}

function activityIdentity(parts: string[]): string {
  const canonical = parts.map((part) => cleanText(part).toLocaleLowerCase("da-DK")).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 20);
}

function unstructuredDetailReasons(description: string | undefined): string[] {
  if (!description) return ["Ommel Samvirke oplyser ikke en beskrivelse af aktiviteten"];
  const reasons: string[] = [];
  if (
    /\b(?:pris|koster|betaling|kontant(?:er)?|mobilepay)\b|\b\d+[,.]?\d*\s*kr\.?\b/iu.test(
      description,
    )
  ) {
    reasons.push("Pris eller betaling fremgår kun af aktivitetens fritekst");
  }
  if (
    /\b(?:tilmeld\w*|bestil\w*|reserv(?:er|ation)\w*|book(?:ing|e|es)?|venteliste)\b/iu.test(
      description,
    )
  ) {
    reasons.push("Tilmelding eller reservation fremgår kun af aktivitetens fritekst");
  }
  if (/\b(?:aflyst|udsat|udskudt|flyttet)\b/iu.test(description)) {
    reasons.push("En mulig statusændring fremgår kun af aktivitetens fritekst");
  }
  return reasons;
}

function sameCandidateMetadata(
  left: NormalizedEventDraft,
  right: NormalizedEventDraft,
): boolean {
  const withoutOccurrences = (candidate: NormalizedEventDraft) => {
    const { occurrences: _occurrences, provenance: _provenance, ...metadata } = candidate;
    return metadata;
  };
  return JSON.stringify(withoutOccurrences(left)) === JSON.stringify(withoutOccurrences(right));
}

function mergeCandidate(
  target: Map<string, NormalizedEventDraft>,
  candidate: NormalizedEventDraft,
  errors: string[],
): void {
  const previous = target.get(candidate.sourceEventId);
  if (!previous) {
    target.set(candidate.sourceEventId, candidate);
    return;
  }
  if (!sameCandidateMetadata(previous, candidate)) {
    errors.push(`Aktivitetsidentiteten ${candidate.sourceEventId} gav modstridende metadata`);
    return;
  }
  previous.occurrences = deduplicateBy(
    [...previous.occurrences, ...candidate.occurrences].sort((left, right) =>
      `${left.date}T${left.startTime ?? ""}`.localeCompare(`${right.date}T${right.startTime ?? ""}`),
    ),
    (occurrence) => occurrence.id,
  );
}

function parseCapturedDialog(
  $: ReturnType<typeof load>,
  capture: ReturnType<ReturnType<typeof load>>,
  viewMonth: DateTime,
  sourceUrl: string,
  retrievedAt: string,
): NormalizedEventDraft {
  const dialogs = capture.find(".mud-dialog[role='dialog']");
  if (dialogs.length !== 1) throw new Error("det gengivne element indeholder ikke præcis én eventdialog");
  const dialog = dialogs.first();
  const headings = textList($, ".mud-dialog-title h6", dialog);
  const title = headings[0];
  if (!title || title.length > 200) throw new Error("eventdialogen mangler en gyldig titel");
  const locationName = headings[1] ? sanitizeOmmelContactText(headings[1]) : undefined;
  if (headings.length > 2) throw new Error("eventdialogens overskrift har en ukendt struktur");

  const captions = textList($, ".mud-dialog-title .mud-typography-caption", dialog);
  if (captions.length !== 1) throw new Error("eventdialogen mangler en entydig oprettelsesdato");
  const createdDate = parseCreatedDate(captions[0]!);
  if (!createdDate) throw new Error("eventdialogens oprettelsesdato kunne ikke fortolkes");

  const starts = textList($, ".event-start-time p", dialog);
  const ends = textList($, ".event-end-time p", dialog);
  const start = parseClock(starts, "Start", viewMonth);
  const end = parseClock(ends, "Slut", viewMonth);
  if (!start || !end) throw new Error("eventdialogens start- eller sluttid kunne ikke fortolkes");
  const startAt = DateTime.fromISO(`${start.date}T${start.time}`, { zone: COPENHAGEN });
  const endAnchor = DateTime.fromISO(start.date, { zone: COPENHAGEN });
  const endDate = resolveShortDate(ends[1]!, endAnchor);
  const endAt = endDate
    ? DateTime.fromISO(`${endDate}T${end.time}`, { zone: COPENHAGEN })
    : DateTime.invalid("invalid end date");
  if (!startAt.isValid || !endAt.isValid || endAt <= startAt || endAt.diff(startAt, "days").days > 31) {
    throw new Error("eventdialogen har et ugyldigt tidsinterval");
  }

  const descriptions = textList($, ".event-description", dialog);
  if (descriptions.length > 1) throw new Error("eventdialogen indeholder flere beskrivelser");
  const description = descriptions[0] ? sanitizeOmmelContactText(descriptions[0]) : undefined;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`eventbeskrivelsen overstiger ${MAX_DESCRIPTION_LENGTH} tegn`);
  }
  const category = textList($, ".mud-chip-content", dialog)[0];
  const identity = activityIdentity([
    createdDate,
    title,
    category ?? "",
    locationName ?? "",
    description ?? "",
  ]);
  const sourceEventId = `activity-${identity}`;
  const occurrenceId = `${sourceEventId}-${start.date}-${start.time.replace(":", "")}`;
  const occurrence: ExplicitOccurrenceDraft = {
    id: occurrenceId,
    date: start.date,
    startTime: start.time,
    ...(end.date !== start.date ? { endDate: end.date } : {}),
    endTime: end.time,
    allDay: false,
    timeUnknown: false,
  };

  const reviewReasons = unstructuredDetailReasons(description);
  if (!locationName) reviewReasons.push("Ommel Samvirke oplyser ikke et sted for aktiviteten");

  return {
    sourceId: definition.id,
    sourceEventId,
    stableId: `${definition.id}-${sourceEventId}`,
    title,
    ...(description ? { description } : {}),
    organizerId: definition.organizerId,
    categoryIds: [...definition.categoryIds],
    ...(locationName ? { location: { name: locationName } } : {}),
    occurrences: [occurrence],
    status: "scheduled",
    availability: "unknown",
    attendance: "unknown",
    attendanceDetails: "Adgangsforhold fremgår ikke struktureret af kalenderen og skal bekræftes.",
    publication: reviewReasons.length > 0 ? "review" : "trusted",
    reviewReasons,
    provenance: {
      sourceId: definition.id,
      externalId: sourceEventId,
      sourceUrl,
      retrievedAt,
    },
  };
}

/** Parse the sanitized, browser-rendered event dialogs from one calendar view. */
export function parseOmmelRenderedCalendar(
  rawHtml: string,
  sourceUrl: string,
  retrievedAt: string,
  now: Date,
  monthsAhead = DEFAULT_MONTHS_AHEAD,
): OmmelCalendarParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    assertSourceUrl(sourceUrl);
    checkedMonthsAhead(monthsAhead);
  } catch (error) {
    return { candidates: [], warnings, errors: [errorMessage(error)] };
  }
  const retrieved = DateTime.fromISO(retrievedAt, { setZone: true });
  if (!retrieved.isValid) {
    return { candidates: [], warnings, errors: ["Indsamlingstidspunktet er ugyldigt"] };
  }

  const html = sanitizeOmmelRenderedHtml(rawHtml);
  const $ = load(html);
  const roots = $("[data-ommel-calendar-capture]");
  if (roots.length !== 1) {
    return {
      candidates: [],
      warnings,
      errors: ["Det gengivne svar mangler én entydig Ommel-kalenderindpakning"],
    };
  }
  const root = roots.first();
  const viewMonth = parseViewMonth(root.attr("data-view-month"));
  if (!viewMonth) {
    return { candidates: [], warnings, errors: ["Kalendervisningen mangler en gyldig måned"] };
  }
  const countValue = root.attr("data-visible-event-count");
  const expectedCount = countValue && /^\d{1,3}$/u.test(countValue) ? Number(countValue) : undefined;
  if (expectedCount === undefined || expectedCount > MAX_EVENTS_PER_MONTH) {
    return { candidates: [], warnings, errors: ["Kalendervisningen har et ugyldigt eventantal"] };
  }
  const captures = root.children("[data-ommel-event-capture]");
  if (captures.length !== expectedCount) {
    errors.push(
      `Kalendervisningen viste ${expectedCount} aktiviteter, men ${captures.length} dialoger blev indsamlet`,
    );
  }

  const today = DateTime.fromJSDate(now, { zone: COPENHAGEN }).startOf("day");
  const lastDay = today.plus({ months: monthsAhead }).endOf("day");
  if (!today.isValid) {
    return { candidates: [], warnings, errors: ["Det angivne nu-tidspunkt er ugyldigt"] };
  }
  const candidates = new Map<string, NormalizedEventDraft>();
  captures.each((index, element) => {
    try {
      const candidate = parseCapturedDialog($, $(element), viewMonth, sourceUrl, retrievedAt);
      candidate.occurrences = candidate.occurrences.filter((occurrence) => {
        const date = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN });
        return date.isValid && date >= today && date <= lastDay;
      });
      if (!candidate.occurrences.length) return;
      mergeCandidate(candidates, candidate, errors);
    } catch (error) {
      errors.push(`Kalenderaktivitet ${index + 1}: ${errorMessage(error)}`);
    }
  });

  return {
    candidates: [...candidates.values()].sort((left, right) =>
      left.sourceEventId.localeCompare(right.sourceEventId),
    ),
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
  };
}

function playwrightExecutablePath(): string | undefined {
  const configured = process.env.AEROEVENTS_CHROMIUM_PATH;
  if (configured) return configured;
  for (const candidate of [
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Indsamlingen blev afbrudt");
}

async function createPlaywrightBrowser(): Promise<OmmelBrowserClient> {
  let playwright: typeof import("@playwright/test");
  try {
    playwright = await import("@playwright/test");
  } catch {
    throw new Error("Ommel Samvirke-crawleren kræver @playwright/test; kør npm install");
  }
  const executablePath = playwrightExecutablePath();
  let browser: import("@playwright/test").Browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--disable-dev-shm-usage"],
    });
  } catch (error) {
    throw new Error(
      `Chromium kunne ikke startes (${errorMessage(error)}). Sæt AEROEVENTS_CHROMIUM_PATH eller kør npx playwright install chromium`,
    );
  }
  const browserContext = await browser.newContext({
    locale: "da-DK",
    timezoneId: COPENHAGEN,
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  await browserContext.route("**/*", async (route) => {
    if (["image", "media", "font"].includes(route.request().resourceType())) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const page = await browserContext.newPage();
  page.setDefaultNavigationTimeout(30_000);
  page.setDefaultTimeout(10_000);
  let navigationStatus = 200;
  let navigationContentType: string | null = "text/html; charset=utf-8";
  let requestedUrl: string = definition.url;

  const monthHeading = async (): Promise<{ label: string; date: string }> => {
    const label = cleanText(
      await page.locator(".mud-cal-toolbar .mud-picker button").first().innerText(),
    ).toLocaleLowerCase("da-DK");
    const parsed = DateTime.fromFormat(label, "LLLL yyyy", {
      locale: "da-DK",
      zone: COPENHAGEN,
    }).startOf("month");
    if (!parsed.isValid) throw new Error(`Ukendt kalendermåned: ${label}`);
    return { label, date: parsed.toISODate()! };
  };

  const captureCurrentMonth = async (signal?: AbortSignal): Promise<OmmelBrowserSnapshot> => {
    abortIfRequested(signal);
    await page.locator(".mud-calendar").waitFor({ state: "visible" });
    const viewMonth = await monthHeading();
    await page.waitForTimeout(400);
    const eventSelector = ".calendar-event-text";
    const eventCount = await page.locator(eventSelector).count();
    if (eventCount > MAX_EVENTS_PER_MONTH) {
      throw new Error(`Kalendermåneden indeholder over ${MAX_EVENTS_PER_MONTH} synlige aktiviteter`);
    }
    const renderedDialogs: string[] = [];
    for (let index = 0; index < eventCount; index += 1) {
      abortIfRequested(signal);
      const currentCount = await page.locator(eventSelector).count();
      if (currentCount !== eventCount) {
        throw new Error("Kalenderen ændrede eventantal under indsamlingen");
      }
      await page.locator(eventSelector).nth(index).click();
      const dialog = page.locator(".mud-dialog[role='dialog']").last();
      await dialog.waitFor({ state: "visible" });
      // MudBlazor mounts the dialog shell before the server-rendered details
      // arrive. Waiting on the stable detail fields avoids recording a
      // transient, structurally incomplete dialog.
      await dialog.locator(".mud-dialog-title .mud-typography-caption").waitFor({ state: "visible" });
      await dialog.locator(".event-start-time p").nth(2).waitFor({ state: "visible" });
      await dialog.locator(".event-end-time p").nth(2).waitFor({ state: "visible" });
      const dialogHtml = await dialog.evaluate((element) => {
        const clone = element.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll("script, style, svg, input, textarea, .event-coordinator")
          .forEach((child) => child.remove());
        return clone.outerHTML;
      });
      renderedDialogs.push(
        `<article data-ommel-event-capture>${dialogHtml}</article>`,
      );
      const closeButton = dialog.locator(".mud-dialog-actions button").filter({ hasText: /^\s*Luk\s*$/iu });
      if ((await closeButton.count()) !== 1) throw new Error("Eventdialogen mangler en entydig Luk-knap");
      await closeButton.click();
      await dialog.waitFor({ state: "detached" });
    }
    const html = sanitizeOmmelRenderedHtml(
      `<!doctype html><html lang="da"><body><main data-ommel-calendar-capture data-view-month="${viewMonth.date}" data-visible-event-count="${eventCount}">${renderedDialogs.join("")}</main></body></html>`,
    );
    if (Buffer.byteLength(html, "utf8") > MAX_RENDERED_HTML_BYTES) {
      throw new Error(`Den gengivne kalendermåned overstiger ${MAX_RENDERED_HTML_BYTES} bytes`);
    }
    return {
      requestedUrl,
      finalUrl: page.url(),
      status: navigationStatus,
      contentType: navigationContentType,
      viewMonth: viewMonth.date,
      html,
    };
  };

  return {
    async open(url, signal) {
      abortIfRequested(signal);
      assertSourceUrl(url);
      requestedUrl = url;
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      navigationStatus = response?.status() ?? 200;
      navigationContentType = response?.headers()["content-type"] ?? null;
      return captureCurrentMonth(signal);
    },
    async next(signal) {
      abortIfRequested(signal);
      const previous = await monthHeading();
      const button = page.getByRole("button", { name: "Next Month", exact: true });
      if ((await button.count()) !== 1) throw new Error("Kalenderen mangler en entydig Næste måned-knap");
      await button.click();
      await page.waitForFunction(
        (oldLabel) => {
          const picker = document.querySelector(".mud-cal-toolbar .mud-picker button");
          return picker?.textContent?.replace(/\s+/g, " ").trim().toLocaleLowerCase("da-DK") !== oldLabel;
        },
        previous.label,
      );
      return captureCurrentMonth(signal);
    },
    async close() {
      await page.close();
      await browserContext.close();
      await browser.close();
    },
  };
}

async function recordSnapshot(
  context: CollectionContext,
  snapshot: OmmelBrowserSnapshot,
  sanitizedHtml: string,
): Promise<void> {
  await context.recordResponse?.({
    url: snapshot.finalUrl || snapshot.requestedUrl,
    status: snapshot.status,
    contentType: snapshot.contentType,
    body: sanitizedHtml,
  });
}

export async function collectOmmelSamvirke(
  context: CollectionContext,
  options: OmmelCollectOptions = {},
): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  let monthsAhead: number;
  try {
    monthsAhead = checkedMonthsAhead(options.monthsAhead ?? DEFAULT_MONTHS_AHEAD);
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: [errorMessage(error)],
    };
  }

  let browser: OmmelBrowserClient;
  try {
    browser = await (options.createBrowser ?? createPlaywrightBrowser)();
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: [errorMessage(error)],
    };
  }

  const candidates = new Map<string, NormalizedEventDraft>();
  const warnings: string[] = [];
  const errors: string[] = [];
  let pagesFetched = 0;
  try {
    for (let offset = 0; offset <= monthsAhead; offset += 1) {
      const snapshot = offset === 0
        ? await browser.open(definition.url, context.signal)
        : await browser.next(context.signal);
      pagesFetched += 1;
      assertSourceUrl(snapshot.requestedUrl);
      assertSourceUrl(snapshot.finalUrl);
      if (snapshot.status >= 400) throw new Error(`Ommel Samvirke svarede HTTP ${snapshot.status}`);
      if (!snapshot.contentType?.toLocaleLowerCase("en-US").includes("text/html")) {
        throw new Error("Ommel Samvirke returnerede ikke HTML");
      }
      const expectedMonth = DateTime.fromJSDate(context.now, { zone: COPENHAGEN })
        .startOf("month")
        .plus({ months: offset })
        .toISODate();
      if (snapshot.viewMonth !== expectedMonth) {
        throw new Error(
          `Kalenderen viste ${snapshot.viewMonth}, men ${expectedMonth} var forventet`,
        );
      }
      const sanitizedHtml = sanitizeOmmelRenderedHtml(snapshot.html);
      await recordSnapshot(context, snapshot, sanitizedHtml);
      const parsed = parseOmmelRenderedCalendar(
        sanitizedHtml,
        snapshot.finalUrl,
        retrievedAt,
        context.now,
        monthsAhead,
      );
      warnings.push(...parsed.warnings);
      errors.push(...parsed.errors.map((error) => `${snapshot.viewMonth}: ${error}`));
      for (const candidate of parsed.candidates) mergeCandidate(candidates, candidate, errors);
      if (parsed.errors.length) break;
    }
  } catch (error) {
    errors.push(errorMessage(error));
  } finally {
    await browser.close().catch((error: unknown) => {
      warnings.push(`Ommel Samvirke-browseren kunne ikke lukkes rent: ${errorMessage(error)}`);
    });
  }

  if (errors.length) {
    const failure = {
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [] as [],
      warnings: [...new Set(warnings)],
      errors: [...new Set(errors)],
    };
    return pagesFetched > 0
      ? { status: "partial", ...failure, discardedCandidateCount: candidates.size }
      : { status: "failed", ...failure };
  }

  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates: [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        occurrences: candidate.occurrences.sort((left, right) =>
          `${left.date}T${left.startTime ?? ""}`.localeCompare(`${right.date}T${right.startTime ?? ""}`),
        ),
      }))
      .sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId)),
    warnings: [...new Set(warnings)],
    errors: [],
  };
}

export const ommelSamvirkeSource: SourceAdapter = {
  definition,
  collect: collectOmmelSamvirke,
};
