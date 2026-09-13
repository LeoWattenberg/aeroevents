import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { safeId } from "./files.js";
import { eventSchema, type EventRecord } from "../../src/lib/schema.js";

export interface PromptDefaults {
  sourceId?: string;
  sourceUrl?: string;
  externalId?: string;
  organizerId?: string;
  categoryIds?: string[];
  title?: string;
  description?: string;
  publication?: "draft" | "published";
}

function withDefault(label: string, value?: string): string {
  return value ? `${label} [${value}]: ` : `${label}: `;
}

export async function promptForEvent(defaults: PromptDefaults = {}): Promise<EventRecord> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interaktiv indtastning kræver en terminal; brug --from med en YAML- eller JSON-fil.");
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const ask = async (label: string, fallback?: string): Promise<string> =>
      (await prompt.question(withDefault(label, fallback))).trim() || fallback || "";

    const title = await ask("Titel", defaults.title);
    const eventId = await ask("Stabilt event-id", safeId(title));
    const description = await ask("Kort offentlig beskrivelse", defaults.description);
    const organizerId = await ask("Arrangør-id", defaults.organizerId);
    const categories = await ask("Kategori-id'er (kommasepareret)", defaults.categoryIds?.join(","));
    const date = await ask("Dato (YYYY-MM-DD)");
    const allDay = (await ask("Heldagsarrangement? (j/N)", "N")).toLowerCase().startsWith("j");
    const startTime = allDay ? "" : await ask("Starttid (HH:mm, tom hvis ukendt)");
    const endTime = !allDay && startTime ? await ask("Sluttid (HH:mm, valgfri)") : "";
    const locationName = await ask("Sted (valgfrit)");
    const city = locationName ? await ask("By (valgfri)") : "";
    const attendanceKind = await ask("Adgang (public/members/registration)", "public");
    const price = await ask("Pris (valgfri)");
    const bookingUrl = await ask("Tilmeldingslink (valgfrit)");
    const sourceUrl = await ask("Offentligt kildelink (valgfrit)", defaults.sourceUrl);

    const eventDate = allDay
      ? { kind: "all-day" as const, date }
      : startTime
        ? { kind: "timed" as const, date, startTime, ...(endTime ? { endTime } : {}) }
        : { kind: "time-unknown" as const, date };

    return eventSchema.parse({
      id: eventId,
      title,
      description,
      organizerId,
      categoryIds: categories.split(",").map((item) => item.trim()).filter(Boolean),
      ...(locationName ? { location: { name: locationName, ...(city ? { city } : {}) } } : {}),
      attendance: { kind: attendanceKind },
      status: "scheduled",
      publication: defaults.publication || "draft",
      ...(price ? { price } : {}),
      ...(bookingUrl ? { booking: { required: false, soldOut: false, url: bookingUrl } } : {}),
      schedule: { kind: "explicit", dates: [eventDate] },
      source: {
        sourceId: defaults.sourceId || "manual",
        ...(defaults.externalId ? { externalId: defaults.externalId } : {}),
        ...(sourceUrl ? { url: sourceUrl } : {}),
      },
    });
  } finally {
    prompt.close();
  }
}

