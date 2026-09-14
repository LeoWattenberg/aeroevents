import { defineCollection } from "astro:content";
import { file } from "astro/loaders";
import {
  buildMetadataSchema,
  candidateSourceSchema,
  categorySchema,
  eventSchema,
  facebookFeedSourceSchema,
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
const facebookSources = defineCollection({ loader: file("data/facebook-sources.yaml"), schema: facebookFeedSourceSchema });
const candidateSources = defineCollection({ loader: file("data/candidate-sources.yaml"), schema: candidateSourceSchema });

export const collections = {
  events,
  occurrences,
  organizers,
  categories,
  sources,
  metadata,
  facebookSources,
  candidateSources,
};
