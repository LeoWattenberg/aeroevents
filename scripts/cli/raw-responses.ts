import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { RawResponseRecorder } from "../sources/types.js";
import { atomicWriteJson, digest, safeId } from "./files.js";

export interface RawResponseCapture {
  runDirectory: string;
  recordResponse: RawResponseRecorder;
}

/** Create a private, collision-safe directory for every collection invocation. */
export function createRawResponseCapture(rawRoot: string, now: Date): RawResponseCapture {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const runId = `${timestamp}-${process.pid}-${randomBytes(6).toString("hex")}`;
  const runDirectory = resolve(rawRoot, runId);
  let sequence = 0;

  return {
    runDirectory,
    recordResponse: async (response) => {
      sequence += 1;
      let host = "response";
      try {
        host = safeId(new URL(response.url).hostname);
      } catch {
        // The URL remains inside the private payload for diagnosis.
      }
      const filename = `${String(sequence).padStart(4, "0")}-${host}-${digest(response.url).slice(0, 10)}.json`;
      await atomicWriteJson(resolve(runDirectory, filename), response, 0o600);
    },
  };
}

