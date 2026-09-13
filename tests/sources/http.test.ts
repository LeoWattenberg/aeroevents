import { describe, expect, it } from "vitest";

import {
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
