import { describe, expect, it } from "vitest";

import {
  fetchJson,
  fetchJsonResponse,
  fetchSourceResponse,
  fetchText,
  sameOriginHttpsUrl,
} from "../../scripts/sources/http";
import { municipalitySource } from "../../scripts/sources/municipality";
import type {
  FetchLike,
  RawSourceResponse,
} from "../../scripts/sources/types";
import { fixture, mappedFetch } from "./test-helpers";

const NOW = new Date("2026-09-13T10:00:00.000Z");

describe("source HTTP boundary", () => {
  it("sends bounded POST JSON with custom source headers and exposes response metadata", async () => {
    const requested: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      body: string | undefined;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fetcher: FetchLike = async (input, init) => {
      requested.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
        redirect: init?.redirect,
      });
      const response = new Response(JSON.stringify({ bookings: [41] }), {
        headers: [
          ["content-type", "application/json; charset=utf-8"],
          ["set-cookie", "session=abc; Path=/; HttpOnly"],
          ["set-cookie", "locale=da; Path=/"],
          ["x-next-page", "2"],
        ],
      });
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://api.source.example/bookings",
      });
      return response;
    };

    const response = await fetchSourceResponse(
      { fetch: fetcher, now: NOW },
      "https://api.source.example/bookings",
      {
        method: "POST",
        headers: {
          cookie: "bootstrap=one",
          origin: "https://source.example",
          referer: "https://source.example/calendar",
        },
        json: { organization: { id: 206 } },
      },
    );

    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      url: "https://api.source.example/bookings",
      method: "POST",
      body: JSON.stringify({ organization: { id: 206 } }),
      redirect: "manual",
    });
    expect(requested[0]!.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(requested[0]!.headers.get("origin")).toBe("https://source.example");
    expect(requested[0]!.headers.get("referer")).toBe("https://source.example/calendar");
    expect(requested[0]!.headers.get("cookie")).toBe("bootstrap=one");
    expect(response).toMatchObject({
      url: "https://api.source.example/bookings",
      status: 200,
      body: JSON.stringify({ bookings: [41] }),
      setCookies: ["session=abc; Path=/; HttpOnly", "locale=da; Path=/"],
    });
    expect(response.headers.get("x-next-page")).toBe("2");
  });

  it("parses JSON with a runtime validation hook and requests JSON explicitly", async () => {
    let accept: string | null = null;
    const value = await fetchJson(
      {
        fetch: async (_input, init) => {
          accept = new Headers(init?.headers).get("accept");
          return new Response('{"id":42}', {
            headers: { "content-type": "application/vnd.source+json" },
          });
        },
        now: NOW,
      },
      "https://source.example/event/42",
      {
        parse(input) {
          if (typeof input !== "object" || input === null || !("id" in input)) {
            throw new Error("id mangler");
          }
          return { id: Number(input.id) };
        },
      },
    );

    expect(value).toEqual({ id: 42 });
    expect(accept).toContain("application/json");
  });

  it("rejects mislabeled and malformed JSON responses with response context", async () => {
    await expect(
      fetchJsonResponse(
        {
          fetch: async () => new Response("{}", { headers: { "content-type": "text/html" } }),
          now: NOW,
        },
        "https://source.example/events",
      ),
    ).rejects.toMatchObject({
      name: "SourceHttpError",
      status: 200,
      url: "https://source.example/events",
    });

    await expect(
      fetchJson(
        {
          fetch: async () =>
            new Response("not json", { headers: { "content-type": "application/json" } }),
          now: NOW,
        },
        "https://source.example/events",
      ),
    ).rejects.toThrow("kunne ikke fortolkes");
  });

  it("rejects unsafe request combinations before making a request", async () => {
    let requested = 0;
    const context = {
      fetch: async () => {
        requested += 1;
        return new Response("should not be reached");
      },
      now: NOW,
    };

    await expect(
      fetchText(context, "https://source.example/events", {
        body: "payload",
        json: { duplicate: true },
      }),
    ).rejects.toThrow("enten body eller json");
    await expect(
      fetchText(context, "https://source.example/events", { json: { get: false } }),
    ).rejects.toThrow("GET-requests");
    await expect(
      fetchText(context, "https://source.example/events", {
        method: "POST",
        headers: { "content-length": "5" },
        body: "hello",
      }),
    ).rejects.toThrow("content-length");
    await expect(
      fetchText(context, "https://source.example/events", {
        method: "POST",
        body: "æøå",
        maxRequestBytes: 5,
      }),
    ).rejects.toThrow("5 bytes");
    expect(requested).toBe(0);
  });

  it("converts POST to GET after a same-origin 303 without forwarding its body", async () => {
    const requests: Array<{ method?: string; body?: BodyInit | null; contentType: string | null }> = [];
    const result = await fetchText(
      {
        fetch: async (input, init) => {
          requests.push({
            ...(init?.method ? { method: init.method } : {}),
            ...(init && "body" in init ? { body: init.body } : {}),
            contentType: new Headers(init?.headers).get("content-type"),
          });
          return String(input).endsWith("/start")
            ? new Response(null, { status: 303, headers: { location: "/result" } })
            : new Response("done");
        },
        now: NOW,
      },
      "https://source.example/start",
      { method: "POST", json: { query: "events" } },
    );

    expect(result).toBe("done");
    expect(requests).toEqual([
      {
        method: "POST",
        body: JSON.stringify({ query: "events" }),
        contentType: "application/json; charset=utf-8",
      },
      { method: "GET", contentType: null },
    ]);
  });

  it("does not forward POST bodies or session headers to a cross-origin redirect", async () => {
    const requested: string[] = [];
    const fetcher: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" },
      });
    };

    await expect(
      fetchText(
        { fetch: fetcher, now: NOW },
        "https://source.example/session",
        {
          method: "POST",
          headers: { cookie: "session=private" },
          json: { municipality: "0492" },
        },
      ),
    ).rejects.toThrow("tilladte origin");
    expect(requested).toEqual(["https://source.example/session"]);
  });

  it("times out an injected fetch and passes it an abort signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const neverSettles: FetchLike = (_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };

    await expect(
      fetchText(
        { fetch: neverSettles, now: NOW },
        "https://source.example/events",
        { timeoutMs: 15 },
      ),
    ).rejects.toThrow("timeout");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("limits the streamed body by bytes rather than JavaScript characters", async () => {
    const fetcher: FetchLike = async () => new Response("æøå");
    let recorded = false;
    await expect(
      fetchText(
        {
          fetch: fetcher,
          now: NOW,
          recordResponse: async () => {
            recorded = true;
          },
        },
        "https://source.example/events",
        { maxBytes: 5 },
      ),
    ).rejects.toThrow("5 bytes");
    expect(recorded).toBe(false);
  });

  it("rejects an oversized declared content length before consuming the body", async () => {
    const fetcher: FetchLike = async () =>
      new Response("small fixture body", {
        headers: { "content-length": "9000" },
      });
    await expect(
      fetchText(
        { fetch: fetcher, now: NOW },
        "https://source.example/events",
        { maxBytes: 100 },
      ),
    ).rejects.toThrow("100 bytes");
  });

  it("resolves only credential-free HTTPS URLs on the expected origin", () => {
    const base = "https://www.arrebib.dk/arrangementer";
    expect(sameOriginHttpsUrl("?page=2", base)).toBe(
      "https://www.arrebib.dk/arrangementer?page=2",
    );
    expect(() => sameOriginHttpsUrl("https://attacker.example/event", base)).toThrow(
      "tilladte origin",
    );
    expect(() => sameOriginHttpsUrl("http://www.arrebib.dk/event", base)).toThrow(
      "tilladte origin",
    );
    expect(() => sameOriginHttpsUrl("https://user@www.arrebib.dk/event", base)).toThrow(
      "tilladte origin",
    );
  });

  it("rejects a cross-origin final response URL after a redirect", async () => {
    const fetcher: FetchLike = async () => {
      const response = new Response("event body");
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://attacker.example/redirected",
      });
      return response;
    };
    await expect(
      fetchText(
        { fetch: fetcher, now: NOW },
        "https://www.arrebib.dk/arrangementer",
        { expectedOrigin: "https://www.arrebib.dk" },
      ),
    ).rejects.toThrow("tilladte origin");
  });

  it("does not request a cross-origin redirect target", async () => {
    const requested: string[] = [];
    const fetcher: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      });
    };

    await expect(
      fetchText(
        { fetch: fetcher, now: NOW },
        "https://www.arrebib.dk/arrangementer",
        { expectedOrigin: "https://www.arrebib.dk" },
      ),
    ).rejects.toThrow("tilladte origin");
    expect(requested).toEqual(["https://www.arrebib.dk/arrangementer"]);
  });

  it("follows a bounded same-origin redirect", async () => {
    const requested: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/events" } })
        : new Response("event body");
    };

    await expect(
      fetchText(
        { fetch: fetcher, now: NOW },
        "https://www.arrebib.dk/start",
        { expectedOrigin: "https://www.arrebib.dk" },
      ),
    ).resolves.toBe("event body");
    expect(requested).toEqual([
      "https://www.arrebib.dk/start",
      "https://www.arrebib.dk/events",
    ]);
  });

  it("retains cookies set during same-origin redirects for session bootstrapping", async () => {
    const response = await fetchSourceResponse(
      {
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/start")) {
            return new Response(null, {
              status: 302,
              headers: [
                ["location", "/authenticated"],
                ["set-cookie", "anonymous=one; Path=/; Secure; HttpOnly"],
              ],
            });
          }
          return new Response("ready", {
            headers: [["set-cookie", "locale=da; Path=/"]],
          });
        },
        now: NOW,
      },
      "https://source.example/start",
    );

    expect(response.body).toBe("ready");
    expect(response.setCookies).toEqual([
      "anonymous=one; Path=/; Secure; HttpOnly",
      "locale=da; Path=/",
    ]);
  });

  it("awaits a raw-response recorder after validating and limiting the body", async () => {
    const records: RawSourceResponse[] = [];
    const fetcher: FetchLike = async () => {
      const response = new Response("fixture body", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://source.example/final",
      });
      return response;
    };
    const body = await fetchText(
      {
        fetch: fetcher,
        now: NOW,
        recordResponse: async (record) => {
          await Promise.resolve();
          records.push(record);
        },
      },
      "https://source.example/events",
    );

    expect(body).toBe("fixture body");
    expect(records).toEqual([
      {
        url: "https://source.example/final",
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "fixture body",
      },
    ]);
  });

  it("turns recorder failure into source failure instead of completing collection", async () => {
    const result = await municipalitySource.collect({
      fetch: mappedFetch({
        [municipalitySource.definition.url]: await fixture("municipality.html"),
      }),
      now: NOW,
      recordResponse: async () => {
        throw new Error("disk full");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.candidates).toEqual([]);
    expect(result.errors.join(" ")).toContain("disk full");
  });
});
