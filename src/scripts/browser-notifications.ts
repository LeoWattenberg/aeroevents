import {
  notificationPreferencesKey,
  occurrenceStartTimestamp,
  parseNotificationCatalog,
  parseNotificationPreferences,
  reconcileRemindersWithCatalog,
  reminderId,
  reminderNotificationTimestamp,
  type CategoryNotificationSubscription,
  type EventReminder,
  type NotificationPreferences,
} from "../lib/notification-preferences";

interface NotificationConfiguration {
  workerUrl: string;
  dataUrl: string;
  homeUrl: string;
  iconUrl: string;
}

interface WorkerResponse {
  ok: boolean;
  error?: string | undefined;
}

interface EventNotificationOccurrence {
  id: string;
  date: string;
  start: string;
  startAt: number;
  allDay: boolean;
  timeUnknown: boolean;
  label: string;
  location?: string | undefined;
}

interface EventNotificationPayload {
  id: string;
  title: string;
  url: string;
  occurrences: EventNotificationOccurrence[];
}

interface CategoryNotificationPayload {
  id: string;
  name: string;
  url: string;
  knownEventIds: string[];
  calendarUrl: string;
  webcalUrl: string;
}

interface PeriodicSyncManager {
  register(tag: string, options: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
}

type RegistrationWithPeriodicSync = ServiceWorkerRegistration & {
  periodicSync?: PeriodicSyncManager | undefined;
};

const PREFERENCE_CHANGE_EVENT = "aeroevents:notification-preferences";
const PERIODIC_SYNC_TAG = "aeroevents-notification-check";
const MAX_TIMER_DELAY = 2_147_000_000;
const WORKER_RESPONSE_TIMEOUT = 8_000;

function scopedSiteUrl(value: string, scope?: URL): URL | undefined {
  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.origin !== window.location.origin) return undefined;
    if (scope && !parsed.pathname.startsWith(scope.pathname)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

const configuration = (() => {
  const { notificationWorker, notificationData, notificationHome, notificationIcon } = document.body.dataset;
  if (!notificationWorker || !notificationData || !notificationHome || !notificationIcon) return undefined;
  const workerUrl = scopedSiteUrl(notificationWorker);
  if (!workerUrl) return undefined;
  const scope = new URL("./", workerUrl);
  const dataUrl = scopedSiteUrl(notificationData, scope);
  const homeUrl = scopedSiteUrl(notificationHome, scope);
  const iconUrl = scopedSiteUrl(notificationIcon, scope);
  if (!dataUrl || !homeUrl || !iconUrl) return undefined;
  return {
    workerUrl: workerUrl.href,
    dataUrl: dataUrl.href,
    homeUrl: homeUrl.href,
    iconUrl: iconUrl.href,
  } satisfies NotificationConfiguration;
})();

const preferencesKey = notificationPreferencesKey(
  configuration ? new URL("./", configuration.workerUrl).pathname : "/",
);

const notificationsSupported = Boolean(
  configuration && window.isSecureContext && "Notification" in window && "serviceWorker" in navigator,
);

let preferences = readPreferences();
let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;
let reminderTimer: number | undefined;

function readPreferences(): NotificationPreferences {
  try {
    return parseNotificationPreferences(window.localStorage.getItem(preferencesKey));
  } catch {
    return parseNotificationPreferences(undefined);
  }
}

function storePreferences(next: NotificationPreferences): boolean {
  try {
    window.localStorage.setItem(preferencesKey, JSON.stringify(next));
    preferences = next;
    window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT));
    return true;
  } catch {
    return false;
  }
}

async function reconcileStoredReminders(): Promise<boolean> {
  if (!configuration) return false;
  if (preferences.reminders.length === 0) return true;

  try {
    const response = await fetch(configuration.dataUrl, { cache: "no-store" });
    if (!response.ok) return false;
    const catalog = parseNotificationCatalog(await response.json());
    if (!catalog) return false;

    const scope = new URL("./", configuration.workerUrl);
    if (
      catalog.events.some((event) => !scopedSiteUrl(event.url, scope))
      || catalog.occurrences.some((occurrence) => !scopedSiteUrl(occurrence.url, scope))
    ) {
      return false;
    }

    const next = reconcileRemindersWithCatalog(preferences, catalog.occurrences);
    if (JSON.stringify(next.reminders) === JSON.stringify(preferences.reminders)) return true;
    return storePreferences(next);
  } catch {
    // A failed or partial catalog must not erase reminders that may still be valid.
    return false;
  }
}

function setStatus(element: HTMLElement | null, message: string, error = false): void {
  if (!element) return;
  element.textContent = message;
  if (error) element.dataset.state = "error";
  else delete element.dataset.state;
}

function unsupportedMessage(): string {
  if (!window.isSecureContext) return "Browserpåmindelser kræver en sikker HTTPS-forbindelse.";
  return "Denne browser understøtter ikke browserpåmindelser på denne enhed.";
}

function permissionMessage(): string {
  if (!notificationsSupported) return unsupportedMessage();
  if (Notification.permission === "denied") {
    return "Notifikationer er blokeret. Du kan ændre tilladelsen i browserens indstillinger.";
  }
  return "";
}

async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function waitForActiveWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  const worker = registration.installing ?? registration.waiting;
  if (!worker && registration.active) return registration;
  if (!worker) throw new Error("The notification service worker did not install");

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("statechange", handleStateChange);
      reject(new Error("The notification service worker did not activate"));
    }, WORKER_RESPONSE_TIMEOUT);
    const handleStateChange = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      window.clearTimeout(timeout);
      worker.removeEventListener("statechange", handleStateChange);
      if (worker.state === "activated") resolve();
      else reject(new Error("The notification service worker became redundant"));
    };
    worker.addEventListener("statechange", handleStateChange);
    handleStateChange();
  });

  if (!registration.active) throw new Error("The notification service worker is not active");
  return registration;
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!notificationsSupported || !configuration) throw new Error("Notifications are not supported");
  if (registrationPromise) return registrationPromise;

  const workerUrl = new URL(configuration.workerUrl, window.location.href);
  const scope = new URL("./", workerUrl).pathname;
  const pending = navigator.serviceWorker
    .register(workerUrl.href, { scope })
    .then(waitForActiveWorker);
  registrationPromise = pending;
  pending.catch(() => {
    if (registrationPromise === pending) registrationPromise = undefined;
  });
  return pending;
}

async function existingServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!configuration || !notificationsSupported) return undefined;
  const expectedScope = new URL("./", configuration.workerUrl).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const registration = registrations.find((candidate) => candidate.scope === expectedScope);
  return registration ? waitForActiveWorker(registration) : undefined;
}

function postMessage(registration: ServiceWorkerRegistration, message: unknown): Promise<void> {
  const worker = registration.active;
  if (!worker) return Promise.reject(new Error("The notification service worker is not active"));

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("The notification service worker did not respond"));
    }, WORKER_RESPONSE_TIMEOUT);

    channel.port1.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "The notification service worker rejected the request"));
    }, { once: true });
    channel.port1.start();
    worker.postMessage(message, [channel.port2]);
  });
}

async function updatePeriodicSync(registration: ServiceWorkerRegistration): Promise<void> {
  const manager = (registration as RegistrationWithPeriodicSync).periodicSync;
  if (!manager) return;

  try {
    if (preferences.reminders.length > 0 || preferences.categories.length > 0) {
      await manager.register(PERIODIC_SYNC_TAG, { minInterval: 60 * 60 * 1_000 });
    } else {
      await manager.unregister(PERIODIC_SYNC_TAG);
    }
  } catch {
    // Browsers gate periodic sync on installation and engagement. On-visit checks remain available.
  }
}

async function syncPreferences(
  checkNow = true,
  existingRegistration?: ServiceWorkerRegistration,
): Promise<void> {
  if (!configuration || !notificationsSupported) return;
  const registration = existingRegistration ?? await ensureServiceWorker();
  await postMessage(registration, {
    type: "SYNC_PREFERENCES",
    configuration,
    reminders: preferences.reminders,
    categories: preferences.categories,
    checkNow,
  });
  await updatePeriodicSync(registration);
  scheduleReminderCheck();
}

function scheduleReminderCheck(): void {
  if (reminderTimer !== undefined) window.clearTimeout(reminderTimer);
  reminderTimer = undefined;

  const now = Date.now();
  const next = preferences.reminders
    .filter((reminder) => reminder.notifyAt > now && reminder.startAt > now)
    .sort((a, b) => a.notifyAt - b.notifyAt)[0];
  if (!next) return;

  reminderTimer = window.setTimeout(() => {
    reminderTimer = undefined;
    void ensureServiceWorker()
      .then((registration) => postMessage(registration, { type: "CHECK_NOTIFICATIONS" }))
      .catch(() => undefined);
    scheduleReminderCheck();
  }, Math.min(next.notifyAt - now, MAX_TIMER_DELAY));
}

function readJson<T>(root: ParentNode, selector: string): T | undefined {
  const script = root.querySelector<HTMLScriptElement>(selector);
  if (!script?.textContent) return undefined;
  try {
    return JSON.parse(script.textContent) as T;
  } catch {
    return undefined;
  }
}

function initializeEventControl(control: HTMLElement): void {
  const payload = readJson<EventNotificationPayload>(control, "[data-event-notification-payload]");
  const occurrenceSelect = control.querySelector<HTMLSelectElement>("[data-reminder-occurrence]");
  const leadSelect = control.querySelector<HTMLSelectElement>("[data-reminder-lead]");
  const toggle = control.querySelector<HTMLButtonElement>("[data-reminder-toggle]");
  const status = control.querySelector<HTMLElement>("[data-notification-status]");
  if (!payload || !occurrenceSelect || !leadSelect || !toggle) return;

  const selectedOccurrence = () => payload.occurrences.find((item) => item.id === occurrenceSelect.value);

  const render = (): void => {
    const occurrence = selectedOccurrence();
    if (!occurrence) {
      toggle.disabled = true;
      setStatus(status, "Tidspunktet kunne ikke læses.", true);
      return;
    }

    const id = reminderId(payload.id, occurrence.id);
    const existing = preferences.reminders.find((reminder) => reminder.id === id);
    if (existing && document.activeElement !== leadSelect) leadSelect.value = String(existing.leadMinutes);

    const startAt = occurrenceStartTimestamp(occurrence);
    for (const option of Array.from(leadSelect.options)) {
      const notifyAt = reminderNotificationTimestamp(occurrence, Number(option.value));
      const isStoredChoice = existing?.leadMinutes === Number(option.value);
      option.disabled = !isStoredChoice && (notifyAt === undefined || notifyAt <= Date.now());
    }

    if (leadSelect.selectedOptions[0]?.disabled) {
      const preferred = ["1440", "60", "0", "10080"]
        .map((value) => Array.from(leadSelect.options).find((option) => option.value === value))
        .find((option) => option && !option.disabled);
      if (preferred) leadSelect.value = preferred.value;
    }

    const selectedLead = Number(leadSelect.value);
    const exactMatch = existing?.leadMinutes === selectedLead;
    toggle.textContent = exactMatch ? "Fjern påmindelse" : existing ? "Opdatér påmindelse" : "Slå påmindelse til";
    toggle.dataset.action = exactMatch ? "remove" : "save";
    toggle.disabled = Boolean(
      (!notificationsSupported && !existing)
      || ((startAt === undefined || startAt <= Date.now() || leadSelect.selectedOptions[0]?.disabled) && !exactMatch),
    );

    if (!notificationsSupported || Notification.permission === "denied") {
      setStatus(status, permissionMessage(), true);
    } else if (startAt === undefined || startAt <= Date.now()) {
      setStatus(status, "Dette tidspunkt er allerede begyndt.", true);
    } else if (existing) {
      setStatus(status, "Påmindelsen er gemt på denne enhed.");
    } else {
      setStatus(status, "");
    }
  };

  occurrenceSelect.addEventListener("change", render);
  leadSelect.addEventListener("change", render);
  toggle.addEventListener("click", async () => {
    const occurrence = selectedOccurrence();
    if (!occurrence) return;
    const id = reminderId(payload.id, occurrence.id);
    const existing = preferences.reminders.find((reminder) => reminder.id === id);
    const leadMinutes = Number(leadSelect.value);

    if (existing?.leadMinutes === leadMinutes) {
      const next = { ...preferences, reminders: preferences.reminders.filter((reminder) => reminder.id !== id) };
      if (!storePreferences(next)) {
        setStatus(status, "Browseren kunne ikke fjerne den gemte påmindelse.", true);
        return;
      }
      render();
      setStatus(status, "Påmindelsen fjernes fra baggrundstjenesten …");
      try {
        await syncPreferences();
        setStatus(status, "Påmindelsen er fjernet.");
      } catch {
        setStatus(status, "Påmindelsen er fjernet her og synkroniseres igen ved næste besøg.", true);
      }
      return;
    }

    const notifyAt = reminderNotificationTimestamp(occurrence, leadMinutes);
    const startAt = occurrenceStartTimestamp(occurrence);
    if (notifyAt === undefined || startAt === undefined || notifyAt <= Date.now()) {
      setStatus(status, "Vælg et senere tidspunkt for påmindelsen.", true);
      return;
    }

    // Keep the permission prompt directly connected to the user's click.
    if (!(await requestNotificationPermission())) {
      setStatus(status, permissionMessage() || "Tilladelsen til notifikationer blev ikke givet.", true);
      render();
      return;
    }

    try {
      await ensureServiceWorker();
    } catch {
      setStatus(status, "Browserpåmindelsen kunne ikke startes. Prøv igen senere.", true);
      return;
    }

    const reminder: EventReminder = {
      id,
      eventId: payload.id,
      occurrenceId: occurrence.id,
      title: payload.title,
      body: `${occurrence.label}${occurrence.location ? ` · ${occurrence.location}` : ""}`,
      url: payload.url,
      startAt,
      notifyAt,
      leadMinutes,
      createdAt: new Date().toISOString(),
    };
    const next = {
      ...preferences,
      reminders: [...preferences.reminders.filter((item) => item.id !== id), reminder],
    };
    if (!storePreferences(next)) {
      setStatus(status, "Browseren kunne ikke gemme påmindelsen på denne enhed.", true);
      return;
    }
    render();
    setStatus(status, "Påmindelsen gemmes i baggrundstjenesten …");
    try {
      await syncPreferences();
      setStatus(status, "Påmindelsen er slået til på denne enhed.");
    } catch {
      setStatus(status, "Påmindelsen er gemt, men baggrundstjenesten kunne ikke opdateres.", true);
    }
  });

  window.addEventListener(PREFERENCE_CHANGE_EVENT, render);
  render();
}

function initializeCategoryControl(control: HTMLElement): void {
  const payload = readJson<CategoryNotificationPayload[]>(control, "[data-category-notification-payload]");
  const select = control.querySelector<HTMLSelectElement>("[data-category-notification-select]");
  const subscribe = control.querySelector<HTMLButtonElement>("[data-category-notification-subscribe]");
  const active = control.querySelector<HTMLElement>("[data-category-notification-active]");
  const list = control.querySelector<HTMLUListElement>("[data-category-notification-list]");
  const status = control.querySelector<HTMLElement>("[data-notification-status]");
  const calendarSubscribe = control.querySelector<HTMLAnchorElement>("[data-category-calendar-subscribe]");
  const calendarUrl = control.querySelector<HTMLInputElement>("[data-category-calendar-url]");
  const calendarCopy = control.querySelector<HTMLButtonElement>("[data-category-calendar-copy]");
  const calendarDownload = control.querySelector<HTMLAnchorElement>("[data-category-calendar-download]");
  const calendarStatus = control.querySelector<HTMLElement>("[data-category-calendar-status]");
  if (
    !payload || !select || !subscribe || !active || !list || !calendarSubscribe
    || !calendarUrl || !calendarCopy || !calendarDownload
  ) return;

  const render = (): void => {
    const selected = payload.find((category) => category.id === select.value);
    const alreadySubscribed = preferences.categories.some((category) => category.id === selected?.id);
    subscribe.textContent = alreadySubscribed ? "Allerede tilmeldt" : "Tilmeld beskeder";
    subscribe.disabled = !notificationsSupported || !selected || alreadySubscribed;
    calendarSubscribe.href = selected?.webcalUrl ?? "#";
    calendarSubscribe.setAttribute("aria-disabled", String(!selected));
    calendarUrl.value = selected?.calendarUrl ?? "";
    calendarDownload.href = selected?.calendarUrl ?? "#";
    calendarDownload.download = selected ? `aeroevents-${selected.id}.ics` : "";

    list.replaceChildren();
    for (const category of preferences.categories) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = category.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Afmeld ${category.name}`);
      remove.addEventListener("click", () => {
        const next = {
          ...preferences,
          categories: preferences.categories.filter((subscription) => subscription.id !== category.id),
        };
        if (!storePreferences(next)) {
          setStatus(status, "Browseren kunne ikke fjerne kategorien.", true);
          return;
        }
        setStatus(status, `Beskeder om ${category.name} fjernes fra baggrundstjenesten …`);
        void syncPreferences().then(
          () => setStatus(status, `Beskeder om ${category.name} er slået fra.`),
          () => setStatus(status, `Beskeder om ${category.name} er slået fra her og synkroniseres igen ved næste besøg.`, true),
        );
      });
      item.append(name, remove);
      list.append(item);
    }
    active.hidden = preferences.categories.length === 0;

    if (!notificationsSupported || Notification.permission === "denied") {
      setStatus(status, permissionMessage(), true);
    } else {
      setStatus(status, "");
    }
  };

  select.addEventListener("change", () => {
    setStatus(calendarStatus, "");
    render();
  });
  calendarCopy.addEventListener("click", async () => {
    calendarUrl.focus();
    calendarUrl.select();
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(calendarUrl.value);
        copied = true;
      }
    } catch {
      copied = false;
    }
    setStatus(
      calendarStatus,
      copied ? "Abonnementslinket er kopieret." : "Linket er markeret. Kopiér det med tastaturet.",
    );
  });
  subscribe.addEventListener("click", async () => {
    const category = payload.find((item) => item.id === select.value);
    if (!category || preferences.categories.some((item) => item.id === category.id)) return;

    if (!(await requestNotificationPermission())) {
      setStatus(status, permissionMessage() || "Tilladelsen til notifikationer blev ikke givet.", true);
      render();
      return;
    }

    try {
      await ensureServiceWorker();
    } catch {
      setStatus(status, "Browserbeskeder kunne ikke startes. Prøv igen senere.", true);
      return;
    }

    const subscription: CategoryNotificationSubscription = {
      id: category.id,
      name: category.name,
      url: category.url,
      knownEventIds: category.knownEventIds,
      subscribedAt: new Date().toISOString(),
    };
    const next = { ...preferences, categories: [...preferences.categories, subscription] };
    if (!storePreferences(next)) {
      setStatus(status, "Browseren kunne ikke gemme kategorien på denne enhed.", true);
      return;
    }
    render();
    setStatus(status, `Tilmeldingen til ${category.name} gemmes i baggrundstjenesten …`);
    try {
      await syncPreferences();
      setStatus(status, `Du får nu besked om nye arrangementer i ${category.name}.`);
    } catch {
      setStatus(status, "Valget er gemt, men baggrundstjenesten kunne ikke opdateres.", true);
    }
  });

  window.addEventListener(PREFERENCE_CHANGE_EVENT, render);
  render();
}

for (const control of document.querySelectorAll<HTMLElement>("[data-event-notifications]")) {
  initializeEventControl(control);
}
for (const control of document.querySelectorAll<HTMLElement>("[data-category-notifications]")) {
  initializeCategoryControl(control);
}

window.addEventListener("storage", (event) => {
  if (event.key !== preferencesKey) return;
  preferences = parseNotificationPreferences(event.newValue);
  window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT));
  void reconcileStoredReminders()
    .then(() => syncPreferences())
    .catch(() => undefined);
});

async function synchronizeOnStartup(): Promise<void> {
  await reconcileStoredReminders();
  if (!notificationsSupported) return;

  if (preferences.reminders.length > 0 || preferences.categories.length > 0) {
    await syncPreferences();
  } else {
    const registration = await existingServiceWorker();
    if (registration) await syncPreferences(false, registration);
  }
}
void synchronizeOnStartup().catch(() => undefined);

window.addEventListener("focus", () => {
  void (async () => {
    await reconcileStoredReminders();
    if (!notificationsSupported || Notification.permission !== "granted") return;
    const registration = await existingServiceWorker();
    if (registration) await syncPreferences(true, registration);
  })().catch(() => undefined);
});
