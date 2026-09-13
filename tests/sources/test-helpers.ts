import { readFile } from "node:fs/promises";

import type { FetchLike } from "../../scripts/sources/types";

export function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function mappedFetch(
  pages: Record<string, string | { status: number; body?: string }>,
): FetchLike {
  return async (input) => {
    const url = String(input);
    const configured = pages[url];
    if (configured === undefined) return new Response("not found", { status: 404 });
    if (typeof configured === "string") {
      return new Response(configured, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(configured.body ?? "request failed", {
      status: configured.status,
    });
  };
}
