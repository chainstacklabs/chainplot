import { createHash } from "node:crypto";

export interface LatestPointer {
  schema_version: 1;
  release_prefix: string;
  release_json_checksum: string;
}

export function latestPointer(releasePrefix: string, releaseJsonBody: string): LatestPointer {
  return {
    schema_version: 1,
    release_prefix: releasePrefix,
    release_json_checksum: createHash("sha256").update(releaseJsonBody).digest("hex"),
  };
}

export function pointerChecksumMatches(
  pointer: LatestPointer,
  releaseJsonBody: string,
): boolean {
  return (
    createHash("sha256").update(releaseJsonBody).digest("hex") ===
    pointer.release_json_checksum
  );
}
