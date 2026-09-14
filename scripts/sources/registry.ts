import type { SourceDefinition } from "./types";

export const SOURCE_REGISTRY = {
  "aeroe-kommune": {
    id: "aeroe-kommune",
    name: "Ærø Kommune — mødeplaner",
    url: "https://www.aeroekommune.dk/politik-og-indflydelse/moedeplaner",
    organizerId: "aeroe-kommune",
    categoryIds: ["politik-kommune"],
  },
  "aeroe-kirkeliv": {
    id: "aeroe-kirkeliv",
    name: "Ærø Kirkeliv — kalender",
    url: "https://widget.churchdesk.com/da/w/1709/event/7HsDjgjjLaLL/1/1350954",
    organizerId: "aeroe-kirkeliv",
    categoryIds: ["kirke"],
  },
  "aeroe-bibliotek": {
    id: "aeroe-bibliotek",
    name: "Ærø Folkebibliotek — arrangementer",
    url: "https://www.arrebib.dk/arrangementer",
    organizerId: "aeroe-folkebibliotek",
    categoryIds: ["musik-kultur"],
  },
  facebook: {
    id: "facebook",
    name: "Facebook — offentlig opdagelse",
    url: "https://www.facebook.com/events/",
    organizerId: "aeroe-kalenderen",
    categoryIds: ["andet"],
  },
} as const satisfies Record<string, SourceDefinition>;

export type RegisteredSourceId = keyof typeof SOURCE_REGISTRY;
