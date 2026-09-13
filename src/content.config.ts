import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
import {
  buildMetadataSchema,
  categorySchema,
  eventSchema,
  occurrenceSchema,
  organizerSchema,
  sourceDefinitionSchema,
} from "./lib/schema";

const events = defineCollection({ loader: file("data/generated/events.json"), schema: eventSchema });
const occurrences = defineCollection({ loader: file("data/generated/occurrences.json"), schema: occurrenceSchema });
const organizers = defineCollection({ loader: file("data/generated/organizers.json"), schema: organizerSchema });
const categories = defineCollection({ loader: file("data/generated/categories.json"), schema: categorySchema });
const sources = defineCollection({ loader: file("data/generated/sources.json"), schema: sourceDefinitionSchema });
const metadata = defineCollection({ loader: file("data/generated/metadata.json"), schema: buildMetadataSchema });

export const collections = { events, occurrences, organizers, categories, sources, metadata };
