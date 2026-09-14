import type { CollectionContext } from "./types";

const USER_AGENT =
  "AeroeventsCalendar/1.0 (+https://github.com/aeroevents/aeroevents)";
const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9";
const JSON_ACCEPT = "application/json,application/*+json;q=0.9";
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_SAFE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type SourceHttpMethod = "GET" | "POST";
export type SourceRequestBody = string | URLSearchParams;

export interface FetchTextOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
  expectedOrigin?: string;
  method?: SourceHttpMethod;
  headers?: HeadersInit;
  body?: SourceRequestBody;
  json?: unknown;
  allowEmpty?: boolean;
}

export interface FetchJsonOptions<T = unknown> extends FetchTextOptions {
  /** Runtime validation/normalization hook, for example a Zod schema's parse method. */
  parse?: (value: unknown) => T;
  requireJsonContentType?: boolean;
}

export interface SourceResponse {
  /** Final response URL after validated same-origin redirects. */
  url: string;
  status: number;
  headers: Headers;
  /** Individual Set-Cookie values, kept separate even when they contain Expires commas. */
  setCookies: string[];
  body: string;
}

export interface SourceJsonResponse<T> extends SourceResponse {
  data: T;
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

function positiveLimit(value: number, label: string, url: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SourceHttpError(`${label} skal være et positivt heltal`, url);
  }
  return value;
}

function requestHeaders(value: HeadersInit | undefined, url: string): Headers {
  let headers: Headers;
  try {
    headers = new Headers(value);
  } catch (error) {
    throw new SourceHttpError(`Ugyldige HTTP-headere: ${errorMessage(error)}`, url);
  }
  for (const header of FORBIDDEN_REQUEST_HEADERS) {
    if (headers.has(header)) {
      throw new SourceHttpError(`HTTP-headeren ${header} må ikke angives manuelt`, url);
    }
  }
  if (!headers.has("accept")) headers.set("accept", DEFAULT_ACCEPT);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  return headers;
}

function serializeRequestBody(
  options: FetchTextOptions,
  headers: Headers,
  url: string,
  maxRequestBytes: number,
): string | undefined {
  const hasBody = Object.prototype.hasOwnProperty.call(options, "body");
  const hasJson = Object.prototype.hasOwnProperty.call(options, "json");
  if (hasBody && hasJson) {
    throw new SourceHttpError("Angiv enten body eller json, ikke begge dele", url);
  }

  let body: string | undefined;
  if (hasJson) {
    try {
      body = JSON.stringify(options.json);
    } catch (error) {
      throw new SourceHttpError(`JSON-requesten kunne ikke serialiseres: ${errorMessage(error)}`, url);
    }
    if (body === undefined) {
      throw new SourceHttpError("JSON-requesten kunne ikke serialiseres", url);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
  } else if (hasBody) {
    if (options.body instanceof URLSearchParams) {
      body = options.body.toString();
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
    } else if (typeof options.body === "string") {
      body = options.body;
    } else {
      throw new SourceHttpError("HTTP-body skal være tekst eller URLSearchParams", url);
    }
  }

  if (body !== undefined && new TextEncoder().encode(body).byteLength > maxRequestBytes) {
    throw new SourceHttpError(
      `HTTP-requestens body overstiger grænsen på ${maxRequestBytes} bytes`,
      url,
    );
  }
  return body;
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

  const declaredCharset = response.headers
    .get("content-type")
    ?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
    ?.toLowerCase();
  const decoderLabel =
    declaredCharset === "iso-8859-1" ||
    declaredCharset === "iso8859-1" ||
    declaredCharset === "latin1" ||
    declaredCharset === "latin-1"
      ? "windows-1252"
      : "utf-8";

  if (!response.body) {
    const body = new TextDecoder(decoderLabel).decode(await response.arrayBuffer());
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
  const decoder = new TextDecoder(decoderLabel);
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

/** Fetch text together with final URL, response headers, and individual cookies. */
export async function fetchSourceResponse(
  context: CollectionContext,
  url: string,
  options: FetchTextOptions = {},
): Promise<SourceResponse> {
  const timeoutMs = positiveLimit(
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "HTTP-timeout",
    url,
  );
  const maxBytes = positiveLimit(
    options.maxBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES,
    "Svargrænsen",
    url,
  );
  const maxRequestBytes = positiveLimit(
    options.maxRequestBytes ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES,
    "Requestgrænsen",
    url,
  );
  const method = options.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    throw new SourceHttpError("HTTP-metoden skal være GET eller POST", url);
  }

  // Even without an explicit expectedOrigin, source requests and redirects stay
  // on the credential-free HTTPS origin of the initially requested URL.
  const expectedBaseUrl = options.expectedOrigin ?? url;
  const requestUrl = sameOriginHttpsUrl(url, expectedBaseUrl);
  const headers = requestHeaders(options.headers, requestUrl);
  let requestBody = serializeRequestBody(options, headers, requestUrl, maxRequestBytes);
  if (method === "GET" && requestBody !== undefined) {
    throw new SourceHttpError("GET-requests må ikke have en body", requestUrl);
  }
  let requestMethod = method;
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

  const operation = (async (): Promise<SourceResponse> => {
    let response: Response | undefined;
    let responseUrl = requestUrl;
    const setCookies: string[] = [];
    for (let redirectCount = 0; redirectCount <= MAX_SAFE_REDIRECTS; redirectCount += 1) {
      try {
        response = await context.fetch(responseUrl, {
          method: requestMethod,
          headers,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          // Validate a source-provided redirect before its target is requested.
          redirect: "manual",
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

      setCookies.push(...response.headers.getSetCookie());

      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location) {
        throw new SourceHttpError("Kildens redirect mangler Location-header", responseUrl, response.status);
      }
      if (redirectCount === MAX_SAFE_REDIRECTS) {
        throw new SourceHttpError(`Kilden brugte mere end ${MAX_SAFE_REDIRECTS} redirects`, responseUrl);
      }
      responseUrl = sameOriginHttpsUrl(location, expectedBaseUrl);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === "POST")) {
        requestMethod = "GET";
        requestBody = undefined;
        headers.delete("content-type");
      }
      await response.body?.cancel().catch(() => undefined);
    }

    if (!response) throw new SourceHttpError("Kilden returnerede intet svar", responseUrl);

    if (response.url) sameOriginHttpsUrl(response.url, expectedBaseUrl);
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
    if (!options.allowEmpty && !body.trim()) {
      throw new SourceHttpError(
        "Kilden returnerede et tomt svar",
        responseUrl,
        response.status,
      );
    }
    const finalResponseUrl = response.url || responseUrl;
    if (context.recordResponse) {
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
    const responseHeaders = new Headers(response.headers);
    return {
      url: finalResponseUrl,
      status: response.status,
      headers: responseHeaders,
      setCookies,
      body,
    };
  })();

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeContextAbort?.();
  }
}

export async function fetchText(
  context: CollectionContext,
  url: string,
  options: FetchTextOptions = {},
): Promise<string> {
  return (await fetchSourceResponse(context, url, options)).body;
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(
    mediaType &&
      (mediaType === "application/json" ||
        mediaType === "text/json" ||
        mediaType.endsWith("+json")),
  );
}

/** Fetch and parse JSON while retaining response metadata for pagination/session setup. */
export async function fetchJsonResponse<T = unknown>(
  context: CollectionContext,
  url: string,
  options: FetchJsonOptions<T> = {},
): Promise<SourceJsonResponse<T>> {
  const { parse, requireJsonContentType = true, ...textOptions } = options;
  const headers = requestHeaders(textOptions.headers, url);
  if (!headers.has("accept") || headers.get("accept") === DEFAULT_ACCEPT) {
    headers.set("accept", JSON_ACCEPT);
  }
  const response = await fetchSourceResponse(context, url, { ...textOptions, headers });
  const contentType = response.headers.get("content-type");
  if (requireJsonContentType && !isJsonContentType(contentType)) {
    throw new SourceHttpError(
      `Kilden returnerede ikke JSON (Content-Type: ${contentType ?? "mangler"})`,
      response.url,
      response.status,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch (error) {
    throw new SourceHttpError(
      `Kildens JSON-svar kunne ikke fortolkes: ${errorMessage(error)}`,
      response.url,
      response.status,
    );
  }
  if (parse) {
    try {
      value = parse(value);
    } catch (error) {
      throw new SourceHttpError(
        `Kildens JSON-svar kunne ikke valideres: ${errorMessage(error)}`,
        response.url,
        response.status,
      );
    }
  }
  return { ...response, data: value as T };
}

export async function fetchJson<T = unknown>(
  context: CollectionContext,
  url: string,
  options: FetchJsonOptions<T> = {},
): Promise<T> {
  return (await fetchJsonResponse(context, url, options)).data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
