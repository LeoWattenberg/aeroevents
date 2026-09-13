import { getCollection } from "astro:content";
import type { BuildMetadata, Category, EventRecord, Occurrence, Organizer, SourceDefinition } from "./schema";

export async function getPublishedEvents(): Promise<EventRecord[]> {
  return (await getCollection("events")).map((entry) => entry.data as EventRecord);
}

export async function getOccurrences(): Promise<Occurrence[]> {
  return (await getCollection("occurrences")).map((entry) => entry.data as Occurrence);
}

export async function getOrganizers(): Promise<Organizer[]> {
  return (await getCollection("organizers")).map((entry) => entry.data as Organizer);
}

export async function getCategories(): Promise<Category[]> {
  return (await getCollection("categories")).map((entry) => entry.data as Category);
}

export async function getSources(): Promise<SourceDefinition[]> {
  return (await getCollection("sources")).map((entry) => entry.data as SourceDefinition);
}

export async function getBuildMetadata(): Promise<BuildMetadata> {
  const [entry] = await getCollection("metadata");
  if (!entry) throw new Error("Buildmetadata mangler");
  return entry.data as BuildMetadata;
}
