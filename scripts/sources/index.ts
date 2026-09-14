import { aeldresagenSource } from "./aeldresagen";
import { aeroeHotelEventsSource } from "./aeroe-hotel-events";
import { aeroeGolfklubSource } from "./aeroe-golfklub";
import { aeroeRideklubSource } from "./aeroe-rideklub";
import { aeroeskoebingGrandPrixSource } from "./aeroeskoebing-grand-prix";
import { aeroeskoebingSejlklubSource } from "./aeroeskoebing-sejlklub";
import { campusSource } from "./campus";
import { churchDeskSource } from "./churchdesk";
import { dnEventsSource } from "./dn-events";
import { facebookSource } from "./facebook-feed";
import { folkedansSource } from "./folkedans";
import { folkeuniversitetSource } from "./folkeuniversitet";
import { klatreklubSource } from "./klatreklub";
import { kunsthoejskolenSource } from "./kunsthoejskolen";
import { librarySource } from "./library";
import { marnavSource } from "./marnav";
import { marstalBillardKlubSource } from "./marstal-billard-klub";
import { marstalIfSource } from "./marstal-if";
import { momoyogaSource } from "./momoyoga";
import { motorfabrikkenSource } from "./motorfabrikken";
import { municipalityEventsSource } from "./municipality-events";
import { municipalitySource } from "./municipality";
import { ommelBkSource } from "./ommel-bk";
import { ommelSamvirkeSource } from "./ommel-samvirke";
import { parkinsonAeroeSource } from "./parkinson-aeroe";
import { riseSifSource } from "./rise-sif";
import { soebyLokalraadSource } from "./soeby-lokalraad";
import { tennisklubSource } from "./tennisklub";
import { viftenSource } from "./viften";
import type { RegisteredSourceId } from "./registry";
import type {
  CollectionContext,
  CollectionResult,
  FetchLike,
  RawResponseRecorder,
  SourceAdapter,
} from "./types";

export * from "./aeldresagen";
export * from "./aeroe-hotel-events";
export * from "./aeroe-golfklub";
export * from "./aeroe-rideklub";
export * from "./aeroeskoebing-grand-prix";
export * from "./aeroeskoebing-sejlklub";
export * from "./campus";
export * from "./churchdesk";
export * from "./dn-events";
export * from "./facebook";
export * from "./facebook-feed";
export * from "./folkedans";
export * from "./folkeuniversitet";
export * from "./klatreklub";
export * from "./kunsthoejskolen";
export * from "./library";
export * from "./marnav";
export * from "./marstal-billard-klub";
export * from "./marstal-if";
export * from "./momoyoga";
export * from "./motorfabrikken";
export * from "./municipality-events";
export * from "./municipality";
export * from "./ommel-bk";
export * from "./ommel-samvirke";
export * from "./parkinson-aeroe";
export * from "./registry";
export * from "./rise-sif";
export * from "./soeby-lokalraad";
export * from "./tennisklub";
export * from "./types";
export * from "./viften";

export const SOURCE_ADAPTERS: Record<RegisteredSourceId, SourceAdapter> = {
  "aeroe-kommune": municipalitySource,
  "aeroe-kirkeliv": churchDeskSource,
  "aeroe-bibliotek": librarySource,
  facebook: facebookSource,
  "rise-sif": riseSifSource,
  "dn-aeroe": dnEventsSource,
  "ritual-momoyoga": momoyogaSource,
  "aeroe-kommune-events": municipalityEventsSource,
  "aeldresagen-aeroe": aeldresagenSource,
  "aeroe-folkedans": folkedansSource,
  viften: viftenSource,
  "aeroe-folkeuniversitet": folkeuniversitetSource,
  motorfabrikken: motorfabrikkenSource,
  "ommel-bk": ommelBkSource,
  marnav: marnavSource,
  "campus-aeroe": campusSource,
  "ommel-samvirke": ommelSamvirkeSource,
  "kunsthoejskolen-aeroe": kunsthoejskolenSource,
  "soeby-lokalraad": soebyLokalraadSource,
  "aeroe-hotel-events": aeroeHotelEventsSource,
  "aeroeskoebing-grand-prix": aeroeskoebingGrandPrixSource,
  "aeroe-klatreklub": klatreklubSource,
  "aeroe-tennisklub": tennisklubSource,
  "parkinsonforeningen-aeroe": parkinsonAeroeSource,
  "aeroe-rideklub": aeroeRideklubSource,
  "aeroe-golfklub": aeroeGolfklubSource,
  "marstal-if": marstalIfSource,
  "marstal-billard-klub": marstalBillardKlubSource,
  "aeroeskoebing-sejlklub": aeroeskoebingSejlklubSource,
};

export interface CollectOptions {
  fetch?: FetchLike;
  now?: Date;
  signal?: AbortSignal;
  recordResponse?: RawResponseRecorder;
}

export type CollectionProgress =
  | {
      phase: "started";
      source: SourceAdapter["definition"];
      position: number;
      total: number;
    }
  | {
      phase: "completed";
      source: SourceAdapter["definition"];
      completed: number;
      total: number;
      result: CollectionResult;
    };

export interface CollectAllOptions extends CollectOptions {
  sourceIds: RegisteredSourceId[];
  onProgress?: (progress: CollectionProgress) => void;
}

function context(options: CollectOptions): CollectionContext {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("Denne Node-version har ingen global fetch");
  return {
    fetch: fetcher,
    now: options.now ?? new Date(),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.recordResponse ? { recordResponse: options.recordResponse } : {}),
  };
}

export function collectSource(
  sourceId: RegisteredSourceId,
  options: CollectOptions = {},
): Promise<CollectionResult> {
  return SOURCE_ADAPTERS[sourceId].collect(context(options));
}

export async function collectAllSources(
  options: CollectAllOptions,
): Promise<CollectionResult[]> {
  const collectionContext = context(options);
  let completed = 0;
  return Promise.all(
    options.sourceIds.map(async (sourceId, index) => {
      const adapter = SOURCE_ADAPTERS[sourceId];
      options.onProgress?.({
        phase: "started",
        source: adapter.definition,
        position: index + 1,
        total: options.sourceIds.length,
      });
      const result = await adapter.collect(collectionContext);
      completed += 1;
      options.onProgress?.({
        phase: "completed",
        source: adapter.definition,
        completed,
        total: options.sourceIds.length,
        result,
      });
      return result;
    }),
  );
}
