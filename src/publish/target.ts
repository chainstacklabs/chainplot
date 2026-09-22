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
  /**
   * The publish root, which forwards to whichever release is current. Stable
   * across republishes, unlike `dashboard_url`. Null when the target declares
   * no public base URL, which is the normal case for a directory target.
   */
  entry_url: string | null;
  /**
   * Whether the forwarding page was written. False only when an index.html
   * chainplot did not write already occupies the publish root, which is a
   * different thing from a target that simply has no public URL to report.
   */
  entry_point_written: boolean;
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
  /**
   * Write the forwarding page beside `latest.json`, so the publish root is a
   * stable URL that renders the current release.
   *
   * Returns false when an index.html is already there that chainplot did not
   * write: a bucket may serve a site of its own, and its front page is not
   * ours to replace.
   */
  promoteEntryPoint(html: string): Promise<boolean>;
  /**
   * Write the same page at the directory key, `<prefix>/`, so the bare URL
   * works on a store that serves keys rather than resolving directories.
   *
   * Returns false where there is nothing to write: a target with no prefix
   * has no directory key, and no filesystem allows a name ending in a
   * separator. Never fatal — the `index.html` written beside it is what every
   * host agrees on, and this only widens where the tidier URL works.
   */
  promoteEntryAlias(html: string): Promise<boolean>;
  /** Whether a release published under `prefix` is still there. */
  releaseExists(prefix: string): Promise<boolean>;
}
