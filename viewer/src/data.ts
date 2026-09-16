import type { ColumnMeta } from "./format.js";

export type { ColumnMeta };

export interface QueryResultDoc {
  schema_version: number;
  query_id: string;
  title?: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  snapshot: string;
  raw_amount_columns?: string[];
  error?: { code: string; message: string } | null;
}

export interface FreshnessDoc {
  kind: "chain" | "snapshot_mtime";
  data_through: { block: number; timestamp: string | null } | null;
  indexed_at: string | null;
  snapshot_mtime: string;
}

export interface ReleaseDoc {
  schema_version: number;
  project_id: string;
  mode: string;
  queries: string[];
  dashboards: string[];
  generated_at: string;
  content_digest?: string;
  snapshots: { dataset_id: string; snapshot_id: string }[];
  coverage: {
    source_id: string;
    start_block: number;
    end_block: number;
    status: string;
  }[];
  finality: { policy: string; depth?: number } | null;
  freshness?: FreshnessDoc;
}

export type ChartKind = "line" | "bar" | "area" | "kpi" | "table";

export interface DashboardPanelDoc {
  query: string;
  chart: ChartKind;
  title?: string;
  description?: string;
  span?: "half" | "full";
  hide_columns?: string[];
  unit?: string;
}

export interface DashboardDoc {
  schema_version: number;
  dashboard_id: string;
  title: string;
  description?: string | null;
  panels: DashboardPanelDoc[];
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
