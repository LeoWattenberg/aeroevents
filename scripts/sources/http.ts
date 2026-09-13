import type { CollectionContext } from "./types";

const USER_AGENT =
  "AeroeventsCalendar/1.0 (+https://github.com/aeroevents/aeroevents)";
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const MAX_SAFE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchTextOptions {
  timeoutMs?: number;
  maxBytes?: number;
  expectedOrigin?: string;
}

export class SourceHttpError extends Error {
  readonly url: string;
  readonly status?: number;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = "SourceHttpError";
    this.url = url;
    if (status !== undefined) this.status = status;
  }
}

/** Resolve a source-provided link while preventing protocol and origin escapes. */
export function sameOriginHttpsUrl(value: string, expectedBaseUrl: string): string {
  let expected: URL;
  let candidate: URL;
  try {
    expected = new URL(expectedBaseUrl);
    candidate = new URL(value, expected);
  } catch {
    throw new SourceHttpError("Kilden indeholdt en ugyldig URL", value);
  }

  if (expected.protocol !== "https:") {
    throw new SourceHttpError("Den forventede kildeorigin skal bruge https", expectedBaseUrl);
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.origin !== expected.origin ||
    candidate.username !== "" ||
    candidate.password !== ""
  ) {
    throw new SourceHttpError(
      `Kilden pegede uden for den tilladte origin ${expected.origin}`,
      candidate.toString(),
    );
  }
  return candidate.toString();
}

async function responseTextWithinLimit(
  response: Response,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new SourceHttpError(
      `Kildens svar overstiger grænsen på ${maxBytes} bytes`,
      url,
      response.status,
    );
  }

  if (!response.body) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      throw new SourceHttpError(
        `Kildens svar overstiger grænsen på ${maxBytes} bytes`,
        url,
        response.status,
      );
    }
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel("response body limit exceeded");
        throw new SourceHttpError(
          `Kildens svar overstiger grænsen på ${maxBytes} bytes`,
          url,
          response.status,
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchText(
  context: CollectionContext,
  url: string,
  options: FetchTextOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SourceHttpError("HTTP-timeout skal være et positivt heltal", url);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SourceHttpError("Svargrænsen skal være et positivt heltal", url);
  }

  const requestUrl = options.expectedOrigin
    ? sameOriginHttpsUrl(url, options.expectedOrigin)
    : url;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeContextAbort: (() => void) | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = new SourceHttpError(
        `Kilden overskred timeout på ${timeoutMs} ms`,
        requestUrl,
      );
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);

    if (context.signal) {
      const abort = () => {
        const abortError = new SourceHttpError("Hentning af kilden blev afbrudt", requestUrl);
        reject(abortError);
        controller.abort(abortError);
      };
      if (context.signal.aborted) {
        abort();
      } else {
        context.signal.addEventListener("abort", abort, { once: true });
        removeContextAbort = () => context.signal?.removeEventListener("abort", abort);
      }
    }
  });

  const operation = (async (): Promise<string> => {
    let response: Response | undefined;
    let responseUrl = requestUrl;
    for (let redirectCount = 0; redirectCount <= MAX_SAFE_REDIRECTS; redirectCount += 1) {
      try {
        response = await context.fetch(responseUrl, {
          headers: {
            accept: "text/html,application/xhtml+xml,application/json;q=0.9",
            "user-agent": USER_AGENT,
          },
          // Validate a source-provided redirect before its target is requested.
          redirect: options.expectedOrigin ? "manual" : "follow",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.reason instanceof SourceHttpError) {
          throw controller.signal.reason;
        }
        if (error instanceof SourceHttpError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new SourceHttpError(`Kunne ikke hente kilden: ${detail}`, responseUrl);
      }

      if (!options.expectedOrigin || !REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location) {
        throw new SourceHttpError("Kildens redirect mangler Location-header", responseUrl, response.status);
      }
      if (redirectCount === MAX_SAFE_REDIRECTS) {
        throw new SourceHttpError(`Kilden brugte mere end ${MAX_SAFE_REDIRECTS} redirects`, responseUrl);
      }
      responseUrl = sameOriginHttpsUrl(location, options.expectedOrigin);
      await response.body?.cancel().catch(() => undefined);
    }

    if (!response) throw new SourceHttpError("Kilden returnerede intet svar", responseUrl);

    if (options.expectedOrigin && response.url) {
      sameOriginHttpsUrl(response.url, options.expectedOrigin);
    }
    if (!response.ok) {
      throw new SourceHttpError(
        `Kilden svarede med HTTP ${response.status}`,
        responseUrl,
        response.status,
      );
    }

    const body = await responseTextWithinLimit(
      response,
      responseUrl,
      maxBytes,
      controller.signal,
    );
    if (!body.trim()) {
      throw new SourceHttpError(
        "Kilden returnerede et tomt svar",
        responseUrl,
        response.status,
      );
    }
    if (context.recordResponse) {
      const finalResponseUrl = response.url || responseUrl;
      try {
        await context.recordResponse({
          url: finalResponseUrl,
          status: response.status,
          contentType: response.headers.get("content-type"),
          body,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SourceHttpError(
          `Kunne ikke gemme råt kildesvar: ${detail}`,
          finalResponseUrl,
          response.status,
        );
      }
    }
    return body;
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeContextAbort?.();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
