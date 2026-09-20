export interface LatestPointer {
  schema_version: 1;
  release_prefix: string;
  release_json_checksum: string;
}

export interface PublishResult {
  target_id: string;
  release_prefix: string;
  latest_url: string | null;
  /** Direct link to this exact release's dashboard, for a human to open. */
  dashboard_url: string | null;
  /** Release-relative keys of datasets uploaded beside the release. */
  datasets_referenced?: string[];
  files_uploaded: number;
  promoted: boolean;
}

export interface PublishTarget {
  uploadFiles(
    releaseDir: string,
    prefix: string,
    files: string[],
  ): Promise<void>;
  /**
   * Upload one file from anywhere on disk to an exact key.
   *
   * A `dataset_referenced` release keeps its parquet outside the release
   * directory, so it cannot be named among `files`.
   */
  uploadExternal(localPath: string, key: string): Promise<void>;
  verifyFiles(
    prefix: string,
    files: string[],
    checksums: Record<string, string>,
  ): Promise<void>;
  readLatest(): Promise<LatestPointer | null>;
  promoteLatest(pointer: LatestPointer): Promise<void>;
  /** Whether a release published under `prefix` is still there. */
  releaseExists(prefix: string): Promise<boolean>;
}
