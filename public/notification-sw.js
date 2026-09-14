/* Browser reminders for the static Aeroevents site. No event pages or assets are cached here. */
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname;
const DATABASE_NAME = `aeroevents-notifications:${encodeURIComponent(SCOPE_PATH)}`;
const DATABASE_VERSION = 1;
const REMINDER_STORE = "reminders";
const CATEGORY_STORE = "categories";
const SETTING_STORE = "settings";
const PERIODIC_SYNC_TAG = "aeroevents-notification-check";
const CATEGORY_CHECK_INTERVAL = 15 * 60 * 1_000;
const CATALOG_RETRY_INTERVAL = 60 * 1_000;
const MAX_TIMER_DELAY = 2_147_000_000;
const REMINDER_START_GRACE_MS = 5 * 60 * 1_000;

let databasePromise;
let reminderTimer;
let operationQueue = Promise.resolve();

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(REMINDER_STORE)) {
        database.createObjectStore(REMINDER_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CATEGORY_STORE)) {
        database.createObjectStore(CATEGORY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SETTING_STORE)) {
        database.createObjectStore(SETTING_STORE, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function readAll(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const completion = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(storeName).getAll());
  await completion;
  return Array.isArray(result) ? result : [];
}

async function readSetting(key) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTING_STORE, "readonly");
  const completion = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(SETTING_STORE).get(key));
  await completion;
  return result?.value;
}

async function writeSetting(key, value) {
  const database = await openDatabase();
  const transaction = database.transaction(SETTING_STORE, "readwrite");
  const completion = transactionDone(transaction);
  transaction.objectStore(SETTING_STORE).put({ key, value });
  await completion;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function scopedUrl(value) {
  if (!isString(value)) return undefined;
  try {
    const parsed = new URL(value, self.location.origin);
    if (parsed.origin !== self.location.origin || !parsed.pathname.startsWith(SCOPE_PATH)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function validConfiguration(value) {
  if (!isRecord(value)) return undefined;
  const workerUrl = scopedUrl(value.workerUrl);
  const dataUrl = scopedUrl(value.dataUrl);
  const homeUrl = scopedUrl(value.homeUrl);
  const iconUrl = scopedUrl(value.iconUrl);
  if (!workerUrl || !dataUrl || !homeUrl || !iconUrl) return undefined;
  if (new URL(workerUrl).pathname !== self.location.pathname) return undefined;
  return { workerUrl, dataUrl, homeUrl, iconUrl };
}

function validReminder(value) {
  return isRecord(value)
    && isString(value.id)
    && isString(value.eventId)
    && isString(value.occurrenceId)
    && isString(value.title)
    && isString(value.body)
    && scopedUrl(value.url) !== undefined
    && Number.isFinite(value.startAt)
    && Number.isFinite(value.notifyAt)
    && Number.isFinite(value.leadMinutes)
    && value.leadMinutes >= 0;
}

function validCategory(value) {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && scopedUrl(value.url) !== undefined
    && Array.isArray(value.knownEventIds);
}

function validCatalogEvent(value) {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && scopedUrl(value.url) !== undefined
    && Array.isArray(value.categoryIds)
    && value.categoryIds.every(isString)
    && (value.nextStart === undefined || isString(value.nextStart));
}

function validCatalogOccurrence(value) {
  return isRecord(value)
    && isString(value.id)
    && isString(value.eventId)
    && isString(value.occurrenceId)
    && value.id === `${value.eventId}::${value.occurrenceId}`
    && isString(value.title)
    && isString(value.body)
    && scopedUrl(value.url) !== undefined
    && Number.isFinite(value.startAt);
}

function validCatalog(value) {
  if (
    !isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.events)
    || !Array.isArray(value.occurrences)
    || !value.events.every(validCatalogEvent)
    || !value.occurrences.every(validCatalogOccurrence)
  ) {
    return undefined;
  }
  const occurrenceIds = value.occurrences.map((occurrence) => occurrence.id);
  return new Set(occurrenceIds).size === occurrenceIds.length ? value : undefined;
}

async function fetchCatalog(configuration) {
  if (!configuration?.dataUrl) return undefined;
  try {
    const response = await fetch(configuration.dataUrl, { cache: "no-store" });
    if (!response.ok) return undefined;
    return validCatalog(await response.json());
  } catch {
    return undefined;
  }
}

function enqueue(operation) {
  operationQueue = operationQueue.then(operation, operation);
  return operationQueue;
}

async function replaceReminders(incoming) {
  const reminders = Array.isArray(incoming) ? incoming.filter(validReminder) : [];
  const existing = new Map((await readAll(REMINDER_STORE)).map((item) => [item.id, item]));
  const incomingIds = new Set(reminders.map((item) => item.id));
  const database = await openDatabase();
  const transaction = database.transaction(REMINDER_STORE, "readwrite");
  const store = transaction.objectStore(REMINDER_STORE);

  for (const previous of existing.values()) {
    if (!incomingIds.has(previous.id)) store.delete(previous.id);
  }
  for (const reminder of reminders) {
    const previous = existing.get(reminder.id);
    const sameSchedule = previous?.notifyAt === reminder.notifyAt && previous?.startAt === reminder.startAt;
    store.put({
      ...reminder,
      ...(sameSchedule && previous.deliveredAt ? { deliveredAt: previous.deliveredAt } : {}),
    });
  }
  await transactionDone(transaction);
}

async function replaceCategories(incoming) {
  const categories = Array.isArray(incoming) ? incoming.filter(validCategory) : [];
  const existing = new Map((await readAll(CATEGORY_STORE)).map((item) => [item.id, item]));
  const incomingIds = new Set(categories.map((item) => item.id));
  const database = await openDatabase();
  const transaction = database.transaction(CATEGORY_STORE, "readwrite");
  const store = transaction.objectStore(CATEGORY_STORE);

  for (const previous of existing.values()) {
    if (!incomingIds.has(previous.id)) store.delete(previous.id);
  }
  for (const category of categories) {
    const previous = existing.get(category.id);
    const knownEventIds = Array.from(new Set([
      ...(previous?.knownEventIds ?? []),
      ...category.knownEventIds.filter(isString),
    ]));
    store.put({ ...category, knownEventIds });
  }
  await transactionDone(transaction);
}

async function reconcileReminders(catalogOccurrences) {
  const currentById = new Map(catalogOccurrences.map((occurrence) => [occurrence.id, occurrence]));
  const reminders = await readAll(REMINDER_STORE);
  const database = await openDatabase();
  const transaction = database.transaction(REMINDER_STORE, "readwrite");
  const store = transaction.objectStore(REMINDER_STORE);
  const now = Date.now();

  for (const reminder of reminders) {
    const current = currentById.get(reminder.id);
    if (
      !validReminder(reminder)
      || !current
      || current.eventId !== reminder.eventId
      || current.occurrenceId !== reminder.occurrenceId
    ) {
      store.delete(reminder.id);
      continue;
    }

    const notifyAt = current.startAt - reminder.leadMinutes * 60_000;
    const sameSchedule = reminder.startAt === current.startAt && reminder.notifyAt === notifyAt;
    const { deliveredAt, ...savedReminder } = reminder;
    const reconciled = {
      ...savedReminder,
      title: current.title,
      body: current.body,
      url: current.url,
      startAt: current.startAt,
      notifyAt,
      ...(sameSchedule && deliveredAt ? { deliveredAt } : {}),
    };
    if (reminderExpirationTimestamp(reconciled) <= now) store.delete(reminder.id);
    else store.put(reconciled);
  }
  await transactionDone(transaction);
}

function sameOriginUrl(value, fallback = self.registration.scope) {
  return scopedUrl(value) ?? scopedUrl(fallback) ?? self.registration.scope;
}

function reminderExpirationTimestamp(reminder) {
  return reminder.startAt + (reminder.leadMinutes === 0 ? REMINDER_START_GRACE_MS : 0);
}

async function checkReminders() {
  const reminders = await readAll(REMINDER_STORE);
  const configuration = validConfiguration(await readSetting("configuration"));
  const now = Date.now();
  const updates = [];

  for (const reminder of reminders) {
    if (reminder.deliveredAt) continue;
    if (reminderExpirationTimestamp(reminder) <= now) {
      updates.push({ ...reminder, deliveredAt: now });
      continue;
    }
    if (reminder.notifyAt > now) continue;

    try {
      await self.registration.showNotification(`Påmindelse · ${reminder.title}`, {
        body: reminder.body,
        data: { url: sameOriginUrl(reminder.url, configuration?.homeUrl ?? self.registration.scope) },
        icon: configuration?.iconUrl,
        lang: "da",
        tag: `event-reminder:${reminder.id}`,
        timestamp: reminder.startAt,
      });
      updates.push({ ...reminder, deliveredAt: now });
    } catch {
      // Retain an undelivered reminder so a later browser opportunity can retry it.
    }
  }

  if (updates.length > 0) {
    const database = await openDatabase();
    const transaction = database.transaction(REMINDER_STORE, "readwrite");
    const store = transaction.objectStore(REMINDER_STORE);
    for (const reminder of updates) store.put(reminder);
    await transactionDone(transaction);
  }
}

async function checkCategories(force = false, availableCatalog) {
  const configuration = validConfiguration(await readSetting("configuration"));
  if (!configuration?.dataUrl) return;
  const subscriptions = await readAll(CATEGORY_STORE);
  if (subscriptions.length === 0) return;

  const lastCheck = Number(await readSetting("last-category-check"));
  if (!force && Number.isFinite(lastCheck) && Date.now() - lastCheck < CATEGORY_CHECK_INTERVAL) return;

  const catalog = availableCatalog ?? await fetchCatalog(configuration);
  if (!catalog) return;
  const events = catalog.events;
  const updates = [];

  for (const subscription of subscriptions) {
    const known = new Set(subscription.knownEventIds);
    const categoryEvents = events.filter((event) => event.categoryIds.includes(subscription.id));
    const newEvents = categoryEvents.filter((event) => !known.has(event.id));
    const merged = {
      ...subscription,
      knownEventIds: Array.from(new Set([...subscription.knownEventIds, ...categoryEvents.map((event) => event.id)])),
    };

    if (newEvents.length > 0) {
      const first = newEvents[0];
      const body = newEvents.length === 1
        ? first.title
        : `${newEvents.length} nye arrangementer er føjet til kalenderen.`;
      const target = newEvents.length === 1 ? first.url : subscription.url;
      try {
        await self.registration.showNotification(`Nyt i ${subscription.name}`, {
          body,
          data: { url: sameOriginUrl(target, subscription.url) },
          icon: configuration.iconUrl,
          lang: "da",
          tag: `category:${subscription.id}:${catalog.generatedAt ?? Date.now()}`,
        });
        updates.push(merged);
      } catch {
        // Do not advance the baseline if the browser could not display the notification.
      }
    } else {
      updates.push(merged);
    }
  }

  if (updates.length > 0) {
    const database = await openDatabase();
    const transaction = database.transaction(CATEGORY_STORE, "readwrite");
    const store = transaction.objectStore(CATEGORY_STORE);
    for (const subscription of updates) store.put(subscription);
    await transactionDone(transaction);
  }
  await writeSetting("last-category-check", Date.now());
}

async function scheduleNextReminder() {
  if (reminderTimer !== undefined) clearTimeout(reminderTimer);
  reminderTimer = undefined;
  const now = Date.now();
  const next = (await readAll(REMINDER_STORE))
    .filter((reminder) => !reminder.deliveredAt && reminderExpirationTimestamp(reminder) > now)
    .sort((a, b) => a.notifyAt - b.notifyAt)[0];
  if (!next) return;

  reminderTimer = setTimeout(() => {
    reminderTimer = undefined;
    void enqueue(() => checkAll());
  }, Math.min(next.notifyAt <= now ? CATALOG_RETRY_INTERVAL : next.notifyAt - now, MAX_TIMER_DELAY));
}

async function checkAll(forceCategories = false) {
  const configuration = validConfiguration(await readSetting("configuration"));
  const reminders = await readAll(REMINDER_STORE);
  let catalog;
  if (configuration && reminders.length > 0) {
    catalog = await fetchCatalog(configuration);
    if (catalog) {
      await reconcileReminders(catalog.occurrences);
      await checkReminders();
    }
    // If fetching fails, keep the reminders untouched and wait for a later check.
  }
  await checkCategories(forceCategories, catalog);
  await scheduleNextReminder();
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(enqueue(async () => {
    await self.clients.claim();
    await checkAll();
  }));
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!isRecord(message) || !isString(message.type)) return;

  let operation;
  if (message.type === "CONFIGURE" && isRecord(message.configuration)) {
    const configuration = validConfiguration(message.configuration);
    if (configuration) operation = () => writeSetting("configuration", configuration);
  } else if (message.type === "SYNC_PREFERENCES") {
    const configuration = validConfiguration(message.configuration);
    if (configuration) {
      operation = async () => {
        await writeSetting("configuration", configuration);
        await replaceReminders(message.reminders);
        await replaceCategories(message.categories);
        if (message.checkNow === false) await scheduleNextReminder();
        else await checkAll();
      };
    }
  } else if (message.type === "SYNC_REMINDERS") {
    operation = async () => {
      await replaceReminders(message.reminders);
      await checkAll();
    };
  } else if (message.type === "SYNC_CATEGORIES") {
    operation = () => replaceCategories(message.categories);
  } else if (message.type === "CHECK_NOTIFICATIONS") {
    operation = () => checkAll();
  }

  const responsePort = event.ports?.[0];
  if (!operation) {
    responsePort?.postMessage({ ok: false, error: "invalid-message" });
    return;
  }

  event.waitUntil(enqueue(operation).then(
    () => responsePort?.postMessage({ ok: true }),
    () => responsePort?.postMessage({ ok: false, error: "operation-failed" }),
  ));
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) event.waitUntil(enqueue(() => checkAll(true)));
});

self.addEventListener("sync", (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) event.waitUntil(enqueue(() => checkAll(true)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const configuration = validConfiguration(await readSetting("configuration"));
    const target = sameOriginUrl(
      event.notification.data?.url,
      configuration?.homeUrl ?? self.registration.scope,
    );
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === target);
    if (exact) return exact.focus();
    const existing = windows[0];
    if (existing && "navigate" in existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
