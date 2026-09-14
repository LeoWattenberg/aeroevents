import { expect, test } from "@playwright/test";

const preferencesKey = "aeroevents.notifications.v1:%2Faeroevents%2F";
const workerDatabaseName = "aeroevents-notifications:%2Faeroevents%2F";
const timeUnknownEventId = "facebook-post-pfbid02lfxucpbjvebxggaqas3unshcydf2dswlutibrwqcx8ytguer7byw4gmjsdq";

interface CatalogOccurrence {
  id: string;
  eventId: string;
  occurrenceId: string;
  title: string;
  body: string;
  url: string;
  startAt: number;
}

async function workerStoreCount(page: import("@playwright/test").Page, storeName: string): Promise<number> {
  return page.evaluate(({ databaseName, objectStoreName }) => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(objectStoreName, "readonly");
      const count = transaction.objectStore(objectStoreName).count();
      count.onerror = () => reject(count.error);
      count.onsuccess = () => resolve(count.result);
    };
  }), { databaseName: workerDatabaseName, objectStoreName: storeName });
}

async function workerStoreValues<T>(
  page: import("@playwright/test").Page,
  storeName: string,
): Promise<T[]> {
  return page.evaluate(({ databaseName, objectStoreName }) => new Promise<T[]>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(objectStoreName, "readonly");
      const values = transaction.objectStore(objectStoreName).getAll();
      values.onerror = () => reject(values.error);
      values.onsuccess = () => resolve(values.result as T[]);
    };
  }), { databaseName: workerDatabaseName, objectStoreName: storeName });
}

async function workerRequest(
  page: import("@playwright/test").Page,
  message: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async (requestMessage) => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error("Service worker is not active");
    return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => reject(new Error("Service worker response timed out")), 5_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.postMessage(requestMessage, [channel.port2]);
    });
  }, message);
}

test.beforeEach(async ({ context, baseURL }) => {
  if (baseURL) await context.grantPermissions(["notifications"], { origin: new URL(baseURL).origin });
});

test("publishes stable reminder records for every current occurrence", async ({ request }) => {
  const response = await request.get("./notification-data.json");
  expect(response.ok()).toBe(true);
  const catalog = await response.json() as { version: number; occurrences: CatalogOccurrence[] };
  const occurrence = catalog.occurrences.find((item) => item.eventId === "aeroe-bibliotek-10260");

  expect(catalog.version).toBe(1);
  expect(catalog.occurrences.length).toBeGreaterThan(0);
  expect(occurrence).toBeDefined();
  expect(occurrence?.id).toBe(`${occurrence?.eventId}::${occurrence?.occurrenceId}`);
  expect(occurrence?.title).toBe("Ude for uden - foredrag med Niels Krause-Kjær");
  expect(occurrence?.body).toContain("Ærø Friskole");
  expect(Number.isFinite(occurrence?.startAt)).toBe(true);
});

test("uses the catalog timestamp in a date-only event reminder payload", async ({ page, request }) => {
  const response = await request.get("./notification-data.json");
  const catalog = await response.json() as { occurrences: CatalogOccurrence[] };
  const catalogOccurrence = catalog.occurrences.find((item) => item.eventId === timeUnknownEventId);
  expect(catalogOccurrence).toBeDefined();

  await page.goto(`./begivenheder/${timeUnknownEventId}/`);
  const payload = await page.locator("[data-event-notification-payload]").evaluate((element) =>
    JSON.parse(element.textContent ?? "{}") as { occurrences: Array<{ id: string; start: string; startAt: number }> });
  const pageOccurrence = payload.occurrences.find((item) => item.id === catalogOccurrence!.occurrenceId);

  expect(pageOccurrence?.start).toBe("2027-05-20");
  expect(pageOccurrence?.startAt).toBe(catalogOccurrence?.startAt);
  expect(new Date(pageOccurrence!.startAt).toISOString()).toBe("2027-05-20T10:00:00.000Z");
});

test("reconciles moved and removed reminders in local storage on startup", async ({ page, request }) => {
  const catalogResponse = await request.get("./notification-data.json");
  const catalog = await catalogResponse.json() as { occurrences: CatalogOccurrence[] };
  const current = catalog.occurrences.find((item) => item.eventId === "aeroe-bibliotek-10260");
  expect(current).toBeDefined();

  await page.addInitScript(({ key, occurrence }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      reminders: [
        {
          ...occurrence,
          title: "Old title",
          body: "Old time and place",
          url: "/aeroevents/old/",
          startAt: 1,
          notifyAt: 1,
          leadMinutes: 60,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
        {
          id: "removed::removed-occurrence",
          eventId: "removed",
          occurrenceId: "removed-occurrence",
          title: "Removed event",
          body: "No longer current",
          url: "/aeroevents/removed/",
          startAt: 1,
          notifyAt: 1,
          leadMinutes: 60,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
      ],
      categories: [],
    }));
  }, { key: preferencesKey, occurrence: current! });

  await page.goto("./");
  await expect.poll(() => page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    return stored.reminders;
  }, preferencesKey)).toEqual([expect.objectContaining({
    id: current!.id,
    title: current!.title,
    body: current!.body,
    url: current!.url,
    startAt: current!.startAt,
    notifyAt: current!.startAt - 60 * 60_000,
  })]);
});

test("stores and removes an individual event reminder on this device", async ({ page, context }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");

  const toggle = page.getByRole("button", { name: "Slå påmindelse til" });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.getByText("Påmindelsen er slået til på denne enhed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fjern påmindelse" })).toBeVisible();

  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), preferencesKey);
  expect(stored.reminders).toHaveLength(1);
  expect(stored.reminders[0].url).toBe("/aeroevents/begivenheder/aeroe-bibliotek-10260/");
  expect(stored.reminders[0].notifyAt).toBeLessThan(stored.reminders[0].startAt);

  const workerUrl = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(workerUrl).toMatch(/\/aeroevents\/notification-sw\.js$/);

  await context.clearPermissions();
  await page.reload();
  await expect(page.getByRole("button", { name: "Fjern påmindelse" })).toBeEnabled();
  await page.getByRole("button", { name: "Fjern påmindelse" }).click();
  await expect(page.getByText("Påmindelsen er fjernet.")).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").reminders, preferencesKey)).toEqual([]);
  await expect.poll(() => workerStoreCount(page, "reminders")).toBe(0);
});

test("subscribes to a category from the current catalog baseline", async ({ page }) => {
  await page.goto("./");
  await page.locator("[data-category-notification-select]").selectOption("musik-kultur");
  await page.getByRole("button", { name: "Tilmeld beskeder" }).click();

  await expect(page.getByText("Du får nu besked om nye arrangementer i Musik og kultur.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Afmeld Musik og kultur" })).toBeVisible();
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), preferencesKey);
  expect(stored.categories).toHaveLength(1);
  expect(stored.categories[0].knownEventIds.length).toBeGreaterThan(0);
  expect(stored.categories[0].url).toBe("/aeroevents/?kategori=musik-kultur#kalender");

  await page.reload();
  await expect(page.getByRole("button", { name: "Afmeld Musik og kultur" })).toBeVisible();
  await page.getByRole("button", { name: "Afmeld Musik og kultur" }).click();
  await expect(page.getByText("Beskeder om Musik og kultur er slået fra.")).toBeVisible();
  await expect.poll(() => workerStoreCount(page, "categories")).toBe(0);
});

test("reconciles an empty local preference set with an existing worker", async ({ page }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");
  await page.getByRole("button", { name: "Slå påmindelse til" }).click();
  await expect(page.getByText("Påmindelsen er slået til på denne enhed.")).toBeVisible();
  await expect.poll(() => workerStoreCount(page, "reminders")).toBe(1);

  await page.evaluate((key) => localStorage.removeItem(key), preferencesKey);
  await page.reload();

  await expect.poll(() => workerStoreCount(page, "reminders")).toBe(0);
});

test("resets worker delivery state when the catalog moves an occurrence", async ({ page }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");
  await page.getByRole("button", { name: "Slå påmindelse til" }).click();
  await expect(page.getByText("Påmindelsen er slået til på denne enhed.")).toBeVisible();

  const before = (await workerStoreValues<Record<string, unknown>>(page, "reminders"))[0]!;
  await page.evaluate(({ databaseName, reminder }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("reminders", "readwrite");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
      transaction.objectStore("reminders").put({
        ...reminder,
        title: "Stale title",
        body: "Stale body",
        startAt: 1,
        notifyAt: 1,
        deliveredAt: Date.now(),
      });
    };
  }), { databaseName: workerDatabaseName, reminder: before });

  expect(await workerRequest(page, { type: "CHECK_NOTIFICATIONS" })).toEqual({ ok: true });
  const reconciled = (await workerStoreValues<Record<string, unknown>>(page, "reminders"))[0]!;
  expect(reconciled).toMatchObject({
    id: before.id,
    title: before.title,
    body: before.body,
    startAt: before.startAt,
    notifyAt: before.notifyAt,
  });
  expect(reconciled).not.toHaveProperty("deliveredAt");
});

test("preserves worker reminders when the catalog fetch fails", async ({ page }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");
  await page.getByRole("button", { name: "Slå påmindelse til" }).click();
  await expect(page.getByText("Påmindelsen er slået til på denne enhed.")).toBeVisible();

  const request = await page.evaluate(() => {
    const { notificationWorker, notificationHome, notificationIcon } = document.body.dataset;
    const absolute = (value: string | undefined) => new URL(value ?? "", window.location.href).href;
    return {
      configuration: {
        workerUrl: absolute(notificationWorker),
        dataUrl: new URL("missing-notification-data.json", absolute(notificationHome)).href,
        homeUrl: absolute(notificationHome),
        iconUrl: absolute(notificationIcon),
      },
      reminder: {
        id: "missing::occurrence",
        eventId: "missing",
        occurrenceId: "occurrence",
        title: "Preserved while offline",
        body: "The catalog is unavailable",
        url: absolute(notificationHome),
        startAt: Date.now() + 60 * 60_000,
        notifyAt: Date.now() + 30 * 60_000,
        leadMinutes: 30,
        createdAt: new Date().toISOString(),
      },
    };
  });

  expect(await workerRequest(page, {
    type: "SYNC_PREFERENCES",
    configuration: request.configuration,
    reminders: [request.reminder],
    categories: [],
  })).toEqual({ ok: true });
  expect(await workerStoreValues<Record<string, unknown>>(page, "reminders")).toEqual([
    expect.objectContaining({ id: request.reminder.id, title: request.reminder.title }),
  ]);
});

test("delivers only after catalog reconciliation and rejects unsafe configuration", async ({ page }) => {
  await page.goto("./begivenheder/aeroe-bibliotek-10260/");
  await page.getByRole("button", { name: "Slå påmindelse til" }).click();
  await expect(page.getByText("Påmindelsen er slået til på denne enhed.")).toBeVisible();

  const request = await page.evaluate(async () => {
    const { notificationWorker, notificationData, notificationHome, notificationIcon } = document.body.dataset;
    const absolute = (value: string | undefined) => new URL(value ?? "", window.location.href).href;
    const preferences = JSON.parse(localStorage.getItem("aeroevents.notifications.v1:%2Faeroevents%2F") ?? "{}");
    const saved = preferences.reminders[0];
    const catalog = await fetch(absolute(notificationData), { cache: "no-store" }).then((response) => response.json());
    const occurrence = catalog.occurrences.find((item: { id: string }) => item.id === saved.id);
    const notifyAt = Date.now() - 100;
    return {
      configuration: {
        workerUrl: absolute(notificationWorker),
        dataUrl: absolute(notificationData),
        homeUrl: absolute(notificationHome),
        iconUrl: absolute(notificationIcon),
      },
      reminder: {
        ...saved,
        title: "Stale title",
        body: "Stale body",
        url: absolute(notificationHome),
        startAt: occurrence.startAt,
        notifyAt,
        leadMinutes: (occurrence.startAt - notifyAt) / 60_000,
        createdAt: new Date().toISOString(),
      },
      currentTitle: occurrence.title,
    };
  });
  expect(await workerRequest(page, {
    type: "SYNC_PREFERENCES",
    configuration: request.configuration,
    reminders: [request.reminder],
    categories: [],
  })).toEqual({ ok: true });

  const notifications = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const stored = JSON.parse(localStorage.getItem("aeroevents.notifications.v1:%2Faeroevents%2F") ?? "{}");
    const matches = await registration.getNotifications({ tag: `event-reminder:${stored.reminders[0].id}` });
    for (const notification of matches) notification.close();
    return matches.map((notification) => notification.title);
  });
  expect(notifications).toEqual([`Påmindelse · ${request.currentTitle}`]);

  expect(await workerRequest(page, {
    type: "SYNC_PREFERENCES",
    configuration: { ...request.configuration, homeUrl: "https://example.com/phishing" },
    reminders: [],
    categories: [],
  })).toEqual({ ok: false, error: "invalid-message" });
  expect(await workerStoreCount(page, "reminders")).toBe(1);
});
