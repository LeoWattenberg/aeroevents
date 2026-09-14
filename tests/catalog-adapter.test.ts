import { describe, expect, it } from "vitest";
import { toCalendarDataset } from "../src/components/catalog-adapter";

const occurrences = [
  {
    id: "event-one:2026-10-01",
    eventId: "event-one",
    recurrenceId: "2026-10-01",
    date: "2026-10-01",
    allDay: true,
    timeUnknown: false,
  },
];

describe("calendar organizer adaptation", () => {
  it("uses an event-level organizer instead of the source calendar owner", () => {
    const dataset = toCalendarDataset(
      [{
        id: "event-one",
        title: "Babysalmesang",
        organizerId: "linda-skjoennemand",
        organizerName: "Linda Skjønnemand",
        categoryIds: ["kirke"],
      }],
      occurrences,
      [{ id: "aeroe-kirkeliv", name: "Ærø Kirkeliv" }],
      [{ id: "kirke", name: "Kirke" }],
    );

    expect(dataset.events[0]?.organizerId).toBe("linda-skjoennemand");
    expect(dataset.organizers).toContainEqual({
      id: "linda-skjoennemand",
      name: "Linda Skjønnemand",
    });
  });

  it("links an event-level name to an existing canonical organizer", () => {
    const dataset = toCalendarDataset(
      [{
        id: "event-one",
        title: "Koncert",
        organizerId: "motorfabrikken-marstal",
        organizerName: "Motorfabrikken Marstal",
        categoryIds: ["musik-kultur"],
      }],
      occurrences,
      [{ id: "motorfabrikken", name: "Motorfabrikken Marstal" }],
      [{ id: "musik-kultur", name: "Musik og kultur" }],
    );

    expect(dataset.events[0]?.organizerId).toBe("motorfabrikken");
    expect(dataset.organizers).toEqual([
      { id: "motorfabrikken", name: "Motorfabrikken Marstal" },
    ]);
  });
});
