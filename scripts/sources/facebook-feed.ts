import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load, type CheerioAPI } from "cheerio";
import { DateTime } from "luxon";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  canonicalFacebookContentUrl,
  facebookContentId,
  isConcreteFacebookContentUrl,
  parseFacebookPostText,
  parseFacebookPublicPage,
} from "./facebook";
import { normalizeFacebookPostText, parseFacebookTimestamp } from "./facebook-post";
import { errorMessage } from "./http";
import { SOURCE_REGISTRY } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  NormalizedEventDraft,
  SourceAdapter,
} from "./types";

const definition = SOURCE_REGISTRY.facebook;
const COPENHAGEN = "Europe/Copenhagen";
const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_MAX_DETAILS = 400;
const DEFAULT_CONCURRENCY = 3;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const configurationPath = fileURLToPath(
  new URL("../../data/facebook-sources.yaml", import.meta.url),
);

const feedSourceSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    eventFeedUrl: z.url().optional(),
    postFeedUrl: z.url().optional(),
    organizerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
    maxItems: z.number().int().min(1).max(30).default(DEFAULT_MAX_ITEMS),
  })
  .refine((value) => value.eventFeedUrl || value.postFeedUrl, {
    message: "Kilden skal have eventFeedUrl eller postFeedUrl",
  });

const feedConfigurationSchema = z.array(feedSourceSchema).min(1);

export type FacebookFeedSource = z.infer<typeof feedSourceSchema>;

export interface FacebookBrowserSnapshot {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  html: string;
}

export interface FacebookBrowserClient {
  open(url: string, signal?: AbortSignal): Promise<FacebookBrowserSnapshot>;
  close(): Promise<void>;
}

export interface FacebookFeedDiscovery {
  url: string;
  kind: "event" | "post";
  text?: string;
  publishedAt?: string;
  truncated: boolean;
}

export interface FacebookFeedCollectOptions {
  sources?: FacebookFeedSource[];
  createBrowser?: () => Promise<FacebookBrowserClient>;
  githubActions?: boolean;
  maxDetails?: number;
  concurrency?: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertFacebookFeedUrl(rawUrl: string, sourceId: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Facebook-kilden ${sourceId} har en ugyldig URL`);
  }
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (
    url.protocol !== "https:" ||
    !(hostname === "facebook.com" || hostname.endsWith(".facebook.com")) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error(`Facebook-kilden ${sourceId} skal bruge en offentlig https-URL på facebook.com`);
  }
}

export function parseFacebookFeedConfiguration(value: unknown): FacebookFeedSource[] {
  const sources = feedConfigurationSchema.parse(value);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`Facebook-kilden ${source.id} er angivet flere gange`);
    ids.add(source.id);
    if (source.eventFeedUrl) assertFacebookFeedUrl(source.eventFeedUrl, source.id);
    if (source.postFeedUrl) assertFacebookFeedUrl(source.postFeedUrl, source.id);
  }
  return sources;
}

export function loadFacebookFeedConfiguration(): FacebookFeedSource[] {
  return parseFacebookFeedConfiguration(parseYaml(readFileSync(configurationPath, "utf8")));
}

function canonicalDiscoveryUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (!isConcreteFacebookContentUrl(url.toString())) return undefined;
    return canonicalFacebookContentUrl(url.toString());
  } catch {
    return undefined;
  }
}

function exactArticleOwner($: CheerioAPI, element: Parameters<CheerioAPI>[0], article: unknown): boolean {
  return $(element).closest("article, [role='article']").get(0) === article;
}

function timestampFromArticle($: CheerioAPI, article: Parameters<CheerioAPI>[0]): string | undefined {
  const time = $(article).find("time[datetime]").first().attr("datetime");
  if (time) {
    const parsed = parseFacebookTimestamp(time);
    if (parsed) return parsed.toUTC().toISO()!;
  }
  const epoch = $(article).find("abbr[data-utime]").first().attr("data-utime");
  if (epoch && /^\d+$/.test(epoch)) {
    const parsed = DateTime.fromSeconds(Number(epoch), { zone: "utc" });
    if (parsed.isValid) return parsed.toISO()!;
  }
  return undefined;
}

function messageFromArticle(
  $: CheerioAPI,
  article: Parameters<CheerioAPI>[0],
): { text?: string; truncated: boolean } {
  const selectors = [
    "[data-testid='post_message']",
    "[data-ad-rendering-role='story_message']",
    "[data-ad-preview='message']",
    ".userContent[data-ft]",
  ];
  const elements = selectors.flatMap((selector) =>
    $(article)
      .find(selector)
      .toArray()
      .filter((element) => exactArticleOwner($, element, article)),
  );
  const messages = new Map<string, boolean>();
  for (const element of elements) {
    const clone = $(element).clone();
    const truncated = clone
      .find(".see_more_link, [role='button']")
      .toArray()
      .some((button) => /^(?:se mere|see more)$/iu.test(normalizeFacebookPostText($(button).text())));
    clone.find(".see_more_link, [role='button']").remove();
    clone.find("br").replaceWith("\n");
    clone.find("p, div").each((_index, child) => {
      $(child).append("\n");
    });
    const text = normalizeFacebookPostText(clone.text());
    if (text) messages.set(text, (messages.get(text) ?? false) || truncated);
  }
  if (messages.size !== 1) return { truncated: messages.size > 1 };
  const [text, buttonTruncated] = [...messages.entries()][0]!;
  return {
    text,
    truncated:
      buttonTruncated || /(?:…|\.\.\.)\s*(?:se mere|see more)?\s*$/iu.test(text),
  };
}

function isPostUrl(url: string): boolean {
  return facebookContentId(url).startsWith("post-");
}

/** Extract concrete event and post permalinks from a browser-rendered Facebook feed. */
export function discoverFacebookFeed(html: string, feedUrl: string): FacebookFeedDiscovery[] {
  const $ = load(html);
  const discoveries = new Map<string, FacebookFeedDiscovery>();

  $("a[href]").each((_index, anchor) => {
    const raw = $(anchor).attr("href");
    const url = raw ? canonicalDiscoveryUrl(raw, feedUrl) : undefined;
    if (!url || isPostUrl(url)) return;
    discoveries.set(url, { url, kind: "event", truncated: false });
  });

  $("article, [role='article']").each((_index, article) => {
    if ($(article).parents("article, [role='article']").length > 0) return;
    const urls = $(article)
      .find("a[href]")
      .toArray()
      .filter((anchor) => exactArticleOwner($, anchor, article))
      .flatMap((anchor) => {
        const raw = $(anchor).attr("href");
        const url = raw ? canonicalDiscoveryUrl(raw, feedUrl) : undefined;
        return url && isPostUrl(url) ? [url] : [];
      });
    const url = [...new Set(urls)][0];
    if (!url) return;
    const message = messageFromArticle($, article);
    discoveries.set(url, {
      url,
      kind: "post",
      ...(message.text ? { text: message.text } : {}),
      ...(timestampFromArticle($, article)
        ? { publishedAt: timestampFromArticle($, article)! }
        : {}),
      truncated: message.truncated,
    });
  });

  return [...discoveries.values()];
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

async function createPlaywrightBrowser(): Promise<FacebookBrowserClient> {
  let playwright: typeof import("@playwright/test");
  try {
    playwright = await import("@playwright/test");
  } catch {
    throw new Error("Facebook-crawleren kræver @playwright/test; kør npm install");
  }
  const executablePath = playwrightExecutablePath();
  let browser;
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

  return {
    async open(url, signal) {
      if (signal?.aborted) throw signal.reason;
      const page = await browserContext.newPage();
      page.setDefaultNavigationTimeout(25_000);
      page.setDefaultTimeout(8_000);
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(800);
        for (let index = 0; index < 2; index += 1) {
          if (signal?.aborted) throw signal.reason;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(500);
        }
        const html = await page.content();
        if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
          throw new Error(`Facebook-svaret overstiger ${MAX_HTML_BYTES} bytes`);
        }
        return {
          requestedUrl: url,
          finalUrl: page.url(),
          status: response?.status() ?? 200,
          contentType: response?.headers()["content-type"] ?? "text/html; charset=utf-8",
          html,
        };
      } finally {
        await page.close();
      }
    },
    async close() {
      await browserContext.close();
      await browser.close();
    },
  };
}

async function recordSnapshot(
  context: CollectionContext,
  snapshot: FacebookBrowserSnapshot,
): Promise<void> {
  await context.recordResponse?.({
    url: snapshot.finalUrl || snapshot.requestedUrl,
    status: snapshot.status,
    contentType: snapshot.contentType,
    body: snapshot.html,
  });
}

function candidateInWindow(candidate: NormalizedEventDraft, now: Date): NormalizedEventDraft | undefined {
  const today = DateTime.fromJSDate(now).setZone(COPENHAGEN).startOf("day");
  const lastDay = today.plus({ months: 12 });
  const occurrences = candidate.occurrences.filter((occurrence) => {
    const date = DateTime.fromISO(occurrence.date, { zone: COPENHAGEN });
    return date.isValid && date >= today && date <= lastDay;
  });
  return occurrences.length ? { ...candidate, occurrences } : undefined;
}

function decorateCandidate(
  candidate: NormalizedEventDraft,
  feedSource: FacebookFeedSource,
  now: Date,
): NormalizedEventDraft | undefined {
  const current = candidateInWindow(candidate, now);
  if (!current) return undefined;
  return {
    ...current,
    organizerId: feedSource.organizerId ?? current.organizerId,
    reviewReasons: [
      ...current.reviewReasons,
      `Fundet via den konfigurerede Facebook-kilde “${feedSource.name}”`,
    ],
  };
}

function selectedSourceIds(): Set<string> | undefined {
  const raw = process.env.AEROEVENTS_FACEBOOK_SOURCE_IDS?.trim();
  return raw ? new Set(raw.split(",").map((item) => item.trim()).filter(Boolean)) : undefined;
}

export async function collectFacebookFeeds(
  context: CollectionContext,
  options: FacebookFeedCollectOptions = {},
): Promise<CollectionResult> {
  const retrievedAt = context.now.toISOString();
  if (options.githubActions ?? process.env.GITHUB_ACTIONS === "true") {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: ["Facebook-browsercrawl køres kun lokalt og er slået fra i GitHub Actions"],
    };
  }

  let configuredSources: FacebookFeedSource[];
  try {
    configuredSources = options.sources ?? loadFacebookFeedConfiguration();
  } catch (error) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: [`Facebook-konfigurationen kunne ikke læses: ${errorMessage(error)}`],
    };
  }
  const selected = selectedSourceIds();
  configuredSources = configuredSources.filter(
    (source) => source.enabled && (!selected || selected.has(source.id)),
  );
  if (selected) {
    const unknown = [...selected].filter((id) => !configuredSources.some((source) => source.id === id));
    if (unknown.length) {
      return {
        status: "failed",
        source: definition,
        retrievedAt,
        pagesFetched: 0,
        candidates: [],
        warnings: [],
        errors: [`Ukendte eller deaktiverede Facebook-kilder: ${unknown.join(", ")}`],
      };
    }
  }
  if (!configuredSources.length) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched: 0,
      candidates: [],
      warnings: [],
      errors: ["Der er ingen aktive Facebook-kilder i data/facebook-sources.yaml"],
    };
  }

  let browser: FacebookBrowserClient;
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
  let pagesFetched = 0;
  let successfulFeeds = 0;
  let detailsFetched = 0;
  const maxDetails = options.maxDetails ?? positiveInteger(
    process.env.AEROEVENTS_FACEBOOK_MAX_DETAILS,
    DEFAULT_MAX_DETAILS,
  );
  const concurrency = options.concurrency ?? positiveInteger(
    process.env.AEROEVENTS_FACEBOOK_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  );

  try {
    const feeds = configuredSources.flatMap((feedSource) =>
      ([...new Set([feedSource.eventFeedUrl, feedSource.postFeedUrl].filter(Boolean))] as string[])
        .map((feedUrl) => ({ feedSource, feedUrl })),
    );
    let nextFeed = 0;
    const runWorker = async (): Promise<void> => {
      while (nextFeed < feeds.length) {
        const feed = feeds[nextFeed];
        nextFeed += 1;
        if (!feed) continue;
        const { feedSource, feedUrl } = feed;
        try {
          const snapshot = await browser.open(feedUrl, context.signal);
          pagesFetched += 1;
          await recordSnapshot(context, snapshot);
          if (snapshot.status >= 400) throw new Error(`HTTP ${snapshot.status}`);
          const feedDiscoveries = discoverFacebookFeed(snapshot.html, feedUrl);
          // Facebook post feeds can contain shared event links, and event feeds
          // can contain surrounding posts. Bound each kind independently so
          // one kind cannot crowd the other out of discovery.
          const discoveries = [
            ...feedDiscoveries.filter((item) => item.kind === "event").slice(0, feedSource.maxItems),
            ...feedDiscoveries.filter((item) => item.kind === "post").slice(0, feedSource.maxItems),
          ];
          successfulFeeds += 1;
          for (const discovery of discoveries) {
            let parsed;
            if (discovery.kind === "post" && discovery.text && !discovery.truncated) {
              parsed = parseFacebookPostText({
                url: discovery.url,
                text: discovery.text,
                retrievedAt,
                ...(discovery.publishedAt ? { publishedAt: discovery.publishedAt } : {}),
              });
              // Ordinary posts are expected. A missing event signal or date is not a crawl failure.
              if (!parsed.candidates.length) continue;
            } else {
              if (detailsFetched >= maxDetails) {
                warnings.push(
                  `${feedSource.name}: detaljegrænsen på ${maxDetails} blev nået; resten kontrolleres næste gang`,
                );
                continue;
              }
              detailsFetched += 1;
              try {
                const detail = await browser.open(discovery.url, context.signal);
                pagesFetched += 1;
                await recordSnapshot(context, detail);
                if (detail.status >= 400) throw new Error(`HTTP ${detail.status}`);
                parsed = parseFacebookPublicPage(detail.html, discovery.url, retrievedAt);
              } catch (error) {
                warnings.push(`${feedSource.name}: ${discovery.url}: ${errorMessage(error)}`);
                continue;
              }
            }
            warnings.push(...parsed.warnings.map((warning) => `${feedSource.name}: ${warning}`));
            for (const rawCandidate of parsed.candidates) {
              const candidate = decorateCandidate(rawCandidate, feedSource, context.now);
              if (!candidate) continue;
              const previous = candidates.get(candidate.sourceEventId);
              if (previous && JSON.stringify(previous.occurrences) !== JSON.stringify(candidate.occurrences)) {
                warnings.push(
                  `${feedSource.name}: Facebook-id ${candidate.sourceEventId} gav forskellige datoer; første fund blev bevaret til review`,
                );
                continue;
              }
              candidates.set(candidate.sourceEventId, previous ?? candidate);
            }
          }
        } catch (error) {
          warnings.push(`${feedSource.name}: ${feedUrl}: ${errorMessage(error)}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), feeds.length) }, () => runWorker()),
    );
  } finally {
    await browser.close().catch((error: unknown) => {
      warnings.push(`Facebook-browseren kunne ikke lukkes rent: ${errorMessage(error)}`);
    });
  }

  if (successfulFeeds === 0) {
    return {
      status: "failed",
      source: definition,
      retrievedAt,
      pagesFetched,
      candidates: [],
      warnings: [],
      errors: warnings.length ? warnings : ["Ingen Facebook-feeds kunne hentes"],
    };
  }
  return {
    status: "complete",
    source: definition,
    retrievedAt,
    pagesFetched,
    candidates: [...candidates.values()].sort((a, b) => a.sourceEventId.localeCompare(b.sourceEventId)),
    warnings: [...new Set(warnings)].sort((a, b) => a.localeCompare(b, "da-DK")),
    errors: [],
  };
}

export const facebookSource: SourceAdapter = {
  definition,
  collect: collectFacebookFeeds,
};
