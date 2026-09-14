import { describe, expect, it } from "vitest";

import {
  motorfabrikkenSource,
  parseMotorfabrikkenEvent,
  parseTicketbutlerList,
  validateMotorfabrikkenTenant,
} from "../../scripts/sources/motorfabrikken";
import { fixture } from "./test-helpers";

const NOW = new Date("2026-09-14T10:00:00.000Z");
function jsonResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" } });
}

describe("Motorfabrikken Ticketbutler source", () => {
  it("pins the response to Motorfabrikken's tenant", async () => {
    const tenant = JSON.parse(await fixture("ticketbutler-tenant.json"));
    expect(validateMotorfabrikkenTenant(tenant)).toEqual([]);
    expect(validateMotorfabrikkenTenant({ ...tenant, domain: "other.ticketbutler.io" })).not.toEqual([]);
  });

  it("keeps the numeric event id and preserves price and sold-out state", async () => {
    const list = parseTicketbutlerList(JSON.parse(await fixture("ticketbutler-list.json")));
    const parsed = parseMotorfabrikkenEvent(
      JSON.parse(await fixture("ticketbutler-detail.json")),
      list.items[0]!,
      NOW.toISOString(),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.candidate).toMatchObject({
      stableId: "motorfabrikken-111001",
      title: "Sys Bjerre Intimkoncert",
      price: "150 kr.",
      availability: "sold-out",
      bookingRequired: true,
      location: { address: "Havnegade 11", postalCode: "5960", city: "Marstal" },
      occurrences: [{ date: "2026-11-06", startTime: "20:00" }],
    });
  });

  it("walks months, days, and details with the required tenant headers", async () => {
    const tenant = await fixture("ticketbutler-tenant.json");
    const calendar = await fixture("ticketbutler-calendar.json");
    const list = await fixture("ticketbutler-list.json");
    const detail = await fixture("ticketbutler-detail.json");
    const requests: Array<{ url: string; headers: Headers }> = [];
    const result = await motorfabrikkenSource.collect({
      now: NOW,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.endsWith("/whitelabel/details/checkout/")) return jsonResponse(tenant);
        if (url.includes("/events/calendar/?")) {
          return jsonResponse(url.includes("year=2026&month=11") ? calendar : "[]");
        }
        if (url.endsWith("/events/list/?date=2026-11-06")) return jsonResponse(list);
        if (url.endsWith("/events/title/sys-bjerre-intimkoncert/")) return jsonResponse(detail);
        return new Response("not found", { status: 404 });
      },
    });
    expect(result.status).toBe("complete");
    expect(result.candidates).toHaveLength(1);
    expect(requests).toHaveLength(16);
    for (const request of requests) {
      expect(request.headers.get("origin")).toBe("https://motorfabrikkenmarstal.ticketbutler.io");
      expect(request.headers.get("referer")).toBe("https://motorfabrikkenmarstal.ticketbutler.io/");
    }
  });

  it("discards all candidates when a required detail changes shape", async () => {
    const tenant = await fixture("ticketbutler-tenant.json");
    const calendar = await fixture("ticketbutler-calendar.json");
    const list = await fixture("ticketbutler-list.json");
    const detail = JSON.parse(await fixture("ticketbutler-detail.json"));
    detail.timezone = "UTC";
    const result = await motorfabrikkenSource.collect({
      now: NOW,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/whitelabel/details/checkout/")) return jsonResponse(tenant);
        if (url.includes("/events/calendar/?")) return jsonResponse(url.includes("month=11") ? calendar : "[]");
        if (url.includes("/events/list/")) return jsonResponse(list);
        return jsonResponse(JSON.stringify(detail));
      },
    });
    expect(result.status).toBe("partial");
    expect(result.candidates).toEqual([]);
  });
});
