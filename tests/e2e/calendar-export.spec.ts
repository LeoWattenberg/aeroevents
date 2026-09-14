import { expect, test } from "@playwright/test";

const unfold = (calendar: string): string => calendar.replace(/\r\n[ \t]/g, "");

test("publishes a base-path-safe web app manifest for background-capable browsers", async ({ request }) => {
  const response = await request.get("./manifest.webmanifest");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/manifest+json; charset=utf-8");
  expect(await response.json()).toMatchObject({
    id: "/aeroevents/",
    start_url: "/aeroevents/",
    scope: "/aeroevents/",
    display: "standalone",
  });
});

test("serves an individual event as a static iCalendar download", async ({ request, baseURL }) => {
  const response = await request.get("./kalender/begivenheder/aeroe-bibliotek-10260.ics");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  const calendar = unfold(await response.text());
  expect(calendar).toContain("BEGIN:VCALENDAR\r\n");
  expect(calendar).toContain("SUMMARY;LANGUAGE=da:Ude for uden - foredrag med Niels Krause-Kjær\r\n");
  expect(calendar).toContain("DTSTART:20260922T160000Z\r\n");
  const eventUrl = new URL("begivenheder/aeroe-bibliotek-10260/", baseURL).href;
  expect(calendar).toContain(`URL:${eventUrl}\r\n`);
  expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
});

test("serves category calendars at stable subscription URLs", async ({ request, baseURL }) => {
  const response = await request.get("./kalender/kategorier/kirke.ics");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  const calendar = unfold(await response.text());
  expect(calendar).toContain("X-WR-CALNAME:Det sker på Ærø – Kirke\r\n");
  expect(calendar).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT6H\r\n");
  const subscriptionUrl = new URL("kalender/kategorier/kirke.ics", baseURL).href;
  expect(calendar).toContain(`SOURCE;VALUE=URI:${subscriptionUrl}\r\n`);
  expect(calendar.match(/BEGIN:VEVENT/g)?.length ?? 0).toBeGreaterThan(1);
  expect(calendar.match(/CATEGORIES;LANGUAGE=da:Kirke\r\n/g)?.length ?? 0).toBeGreaterThan(1);
});

test("keeps a category subscription valid before it has any current events", async ({ request }) => {
  const response = await request.get("./kalender/kategorier/forening-faellesskab.ics");

  expect(response.status()).toBe(200);
  const calendar = unfold(await response.text());
  expect(calendar).toMatch(/BEGIN:(?:VEVENT|VTIMEZONE)\r\n/);
  if (!calendar.includes("BEGIN:VEVENT")) {
    expect(calendar).toContain("X-AEROEVENTS-EMPTY:TRUE\r\n");
    expect(calendar).toContain("BEGIN:VTIMEZONE\r\n");
  }
});

test("offers an individual calendar download on the event page", async ({ page, baseURL }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");

  const calendarLink = page.getByRole("link", { name: "Føj til kalender", exact: true });
  await expect(calendarLink).toHaveAttribute(
    "href",
    new URL("kalender/begivenheder/aeroe-bibliotek-10260.ics", baseURL).pathname,
  );
  await expect(calendarLink).toHaveAttribute("download", "aeroevents-aeroe-bibliotek-10260.ics");
});

test("uses one category choice for browser alerts and calendar subscriptions", async ({ page, baseURL }) => {
  await page.goto("./");

  const followPanel = page.locator("[data-category-notifications]");
  await followPanel.getByLabel("Kategori", { exact: true }).selectOption("kirke");
  const subscriptionUrl = new URL("kalender/kategorier/kirke.ics", baseURL).href;
  await expect(followPanel.getByRole("link", { name: "Abonnér i kalender" })).toHaveAttribute(
    "href",
    subscriptionUrl.replace(/^https?:\/\//, "webcal://"),
  );
  await expect(followPanel.getByLabel("Abonnementslink")).toHaveValue(subscriptionUrl);
  await expect(followPanel.getByRole("link", { name: /Hent et øjebliksbillede/ })).toHaveAttribute(
    "href",
    subscriptionUrl,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test("keeps every category feed reachable without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ...(baseURL ? { baseURL } : {}),
  });
  const page = await context.newPage();
  await page.goto("./");

  const fallback = page.locator(".calendar-feed-list");
  const subscriptionUrl = new URL("kalender/kategorier/kirke.ics", baseURL).href;
  await expect(fallback.getByRole("link")).toHaveCount(8);
  await expect(fallback.getByRole("link", { name: "Kirke", exact: true })).toHaveAttribute(
    "href",
    subscriptionUrl,
  );
  await context.close();
});
