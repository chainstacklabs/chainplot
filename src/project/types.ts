export interface Dataset {
  id: string;
  snapshot: string;
  schema?: string;
}

/**
 * A column holding an integer token amount as a decimal string. `decimals`
 * and `symbol` are display hints only: the stored value is never rewritten,
 * so uint256 precision survives the round trip (spec §12).
 */
export interface RawAmountColumn {
  name: string;
  decimals?: number;
  symbol?: string;
  label?: string;
}

/** Bare name, or the same column with display metadata attached. */
export type RawAmountColumnSpec = string | RawAmountColumn;

export interface Query {
  id: string;
  file: string;
  dataset: string;
  title?: string;
  raw_amount_columns?: RawAmountColumnSpec[];
}

export type ChartKind = "line" | "bar" | "area" | "kpi" | "table";

export interface DashboardPanel {
  query: string;
  chart: ChartKind;
  title?: string;
  description?: string;
  span?: "half" | "full";
  hide_columns?: string[];
  unit?: string;
}

export interface Dashboard {
  id: string;
  title: string;
  description?: string;
  panels: DashboardPanel[];
}

export interface Model {
  id: string;
  file: string;
  depends_on: string[];
  columns?: string[];
}

export type Finality =
  | { policy: "finalized" }
  | { policy: "confirmation_depth"; depth: number };

export interface ChainSource {
  id: string;
  chain_id: number;
  rpc_secret: string;
  finality: Finality;
}

export type EventEnd =
  | { mode: "pinned"; block: number }
  | { mode: "follow_finalized" };

export interface IndexedFilter {
  event_name: string;
  indexed_1?: string[];
  indexed_2?: string[];
  indexed_3?: string[];
}

export interface EventSource {
  id: string;
  chain: string;
  addresses: string[];
  abi: string;
  events: string[];
  start_block: number;
  end: EventEnd;
  indexed_filters?: IndexedFilter[];
}

export interface PublishTarget {
  id: string;
  type: "directory" | "s3";
  path?: string;
  bucket?: string;
  /** Key prefix inside the target; namespaces one project within a shared bucket. */
  prefix?: string;
  dataset_license?: string;
  public_base_url?: string;
}

export interface ProjectDocument {
  format_version: 1;
  id: string;
  datasets?: Dataset[];
  queries?: Query[];
  dashboards?: Dashboard[];
  models?: Model[];
  chain_sources?: ChainSource[];
  event_sources?: EventSource[];
  publish_targets?: PublishTarget[];
  policy?: {
    block_budget?: number;
    /** Rows a single query may return; see src/project/limits.ts. */
    row_limit?: number;
    /** Default release mode for `build`; the CLI flag still wins. */
    release_mode?: "dataset_included" | "results_only" | "dataset_referenced";
  };
}
