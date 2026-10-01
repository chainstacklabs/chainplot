import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchJson,
  type ChartKind,
  type ColumnMeta,
  type DashboardDoc,
  type DashboardPanelDoc,
  type QueryResultDoc,
  type ReleaseDoc,
} from "./data.js";
import {
  columnKind,
  compareValues,
  explorerHref,
  formatCell,
  headerHelp,
  headerLabel,
  isHex,
  isNumericColumn,
  kpiStandsAlone,
  relativeTime,
  rowMatches,
  rowWindow,
  sqlHref,
  toChartNumber,
  toCsv,
  type ColumnKind,
  type PanelColumn,
} from "./format.js";

/** Where a reader learns how to rebuild a release from its dataset. */
const CHAINPLOT_REPO_URL = "https://github.com/chainstacklabs/chainplot";
const FORK_HOWTO_URL = `${CHAINPLOT_REPO_URL}#fork-a-published-release`;

/** Columns the panel asked to compute but not show, e.g. an explicit sort key. */
function visibleColumns(
  columns: ColumnMeta[],
  hidden: string[] | undefined,
): number[] {
  const drop = new Set((hidden ?? []).map((name) => name.toLowerCase()));
  return columns
    .map((column, index) => (drop.has(column.name.toLowerCase()) ? -1 : index))
    .filter((index) => index >= 0);
}

function Chip({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </span>
  );
}

// Up to this many bars, every bar gets its label.
const MAX_NAMED_BARS = 30;

function Chart({
  result,
  kind,
  columns,
  presentation,
}: {
  result: QueryResultDoc;
  kind: ChartKind;
  columns: number[];
  presentation: Record<string, PanelColumn> | undefined;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const instanceRef = useRef<{ dispose(): void; resize(): void } | null>(null);

  useEffect(() => {
    if (!el) return;
    let disposed = false;

    // Loaded on demand and tree-shaken: a release with only KPI and table
    // panels never downloads the charting library at all.
    void import("./echarts.js").then(({ init }) => {
      if (disposed) return;
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      const instance = init(el, undefined, { renderer: "canvas" });
      instanceRef.current = instance;

      const [categoryIndex, ...seriesIndexes] = columns;
      if (categoryIndex === undefined) return;
      const axis = result.rows.map((row) => String(row[categoryIndex] ?? ""));
      // A few bars are named things — tokens, wallets — and a dropped label
      // leaves a bar nobody can identify, so all of them are shown, tilted once
      // they would collide. Past that, the axis is a scale (a bar per day, say)
      // and thinning its labels out is the right call, as on a line.
      const named = kind === "bar" && axis.length <= MAX_NAMED_BARS;
      const crowded =
        named && axis.reduce((sum, label) => sum + label.length, 0) * 7 > el.clientWidth * 0.8;
      // cp-ui-kit border-static / text-secondary, per theme.
      const grid = dark ? "#2e3338" : "#e4ebf1";
      const text = dark ? "#8d95a5" : "#606772";

      instance.setOption({
        animationDuration: 400,
        // Chainstack brand blue leading, then the kit's status contrasts.
        color: dark
          ? ["#007bff", "#2dd272", "#25a4ff", "#ffdd33", "#ff294c"]
          : ["#007bff", "#25b15f", "#0095ff", "#ffd102", "#ff1a40"],
        grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: kind === "bar" ? "shadow" : "line" },
        },
        legend:
          seriesIndexes.length > 1
            ? { top: 0, textStyle: { color: text }, icon: "roundRect" }
            : undefined,
        xAxis: {
          type: "category",
          data: axis,
          boundaryGap: kind === "bar",
          axisLine: { lineStyle: { color: grid } },
          axisLabel:
            named
              ? {
                  color: text,
                  interval: 0,
                  rotate: crowded ? 35 : 0,
                  width: crowded ? 110 : undefined,
                  overflow: crowded ? "truncate" : undefined,
                }
              : { color: text, hideOverlap: true },
        },
        yAxis: {
          type: "value",
          splitLine: { lineStyle: { color: grid } },
          axisLabel: { color: text },
        },
        series: seriesIndexes.map((index) => {
          const column = result.columns[index]!;
          return {
            name: headerLabel(column, presentation?.[column.name]),
            type: kind === "bar" ? "bar" : "line",
            smooth: kind !== "bar",
            showSymbol: result.rows.length <= 60,
            areaStyle: kind === "area" ? { opacity: 0.18 } : undefined,
            barMaxWidth: 36,
            itemStyle: { borderRadius: kind === "bar" ? [4, 4, 0, 0] : 0 },
            data: result.rows.map((row) => toChartNumber(row[index], column)),
          };
        }),
      });
    });

    const observer = new ResizeObserver(() => instanceRef.current?.resize());
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [result, kind, columns, presentation, el]);

  return <div className="chart" ref={setEl} />;
}

/** Copies the exact value; says so for a moment, so the click is not silent. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={`copy${copied ? " copied" : ""}`}
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={copied ? "Copied" : "Copy full value"}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

/**
 * A hex value or a block: shortened unless the panel asks for it in full,
 * always copyable whole, and linked when the project names an explorer.
 */
function ValueCell({
  value,
  text,
  kind,
  full,
  explorerUrl,
}: {
  value: unknown;
  text: string;
  kind: ColumnKind;
  full: boolean;
  explorerUrl: string | null;
}) {
  const exact = String(value);
  const shown = full && isHex(value) ? exact : text;
  const href = explorerHref(explorerUrl, kind, value);
  return (
    <span className="value">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" title={`Open ${exact} in the explorer`}>
          {shown}
        </a>
      ) : (
        <span title={shown === exact ? undefined : exact}>{shown}</span>
      )}
      {isHex(value) ? <CopyButton value={exact} /> : null}
    </span>
  );
}

// Below this, rendering every row costs nothing and avoids the measurement
// dance entirely.
const VIRTUALIZE_ABOVE = 200;
// Rows rendered beyond the viewport, so a fast scroll does not show gaps.
const OVERSCAN = 12;
// Only a starting guess: the real height is measured from the first render,
// so this constant and the stylesheet cannot drift apart.
const ASSUMED_ROW_HEIGHT = 33;

// A table this long gets a filter box; a shorter one is read at a glance.
const FILTER_ABOVE = 10;

function DataTable({
  result,
  columns,
  presentation,
  explorerUrl,
}: {
  result: QueryResultDoc;
  columns: number[];
  presentation: Record<string, PanelColumn> | undefined;
  explorerUrl: string | null;
}) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [needle, setNeedle] = useState("");
  const [asc, setAsc] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [rowHeight, setRowHeight] = useState(ASSUMED_ROW_HEIGHT);
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);

  // Alignment is decided once per column, so a header, its figures and a null
  // among them all sit on the same edge.
  const numericColumns = useMemo(() => {
    const numeric = new Set<number>();
    for (const index of columns) {
      const column = result.columns[index];
      if (!column) continue;
      if (isNumericColumn(column, result.rows.map((row) => row[index]))) {
        numeric.add(index);
      }
    }
    return numeric;
  }, [columns, result]);

  const kinds = useMemo(() => {
    const out = new Map<number, ColumnKind>();
    for (const index of columns) {
      const column = result.columns[index];
      if (!column) continue;
      out.set(
        index,
        columnKind(column, presentation?.[column.name], result.rows.map((row) => row[index])),
      );
    }
    return out;
  }, [columns, result, presentation]);

  const filtered = useMemo(
    () => (needle ? result.rows.filter((row) => rowMatches(row, columns, needle)) : result.rows),
    [result, columns, needle],
  );

  const sorted = useMemo(() => {
    if (sortCol === null) return filtered;
    const rows = [...filtered];
    rows.sort((a, b) => {
      const cmp = compareValues(a[sortCol], b[sortCol]);
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [filtered, sortCol, asc]);

  const virtual = sorted.length > VIRTUALIZE_ABOVE;

  // Measure a real row rather than trusting a constant to match the CSS.
  useEffect(() => {
    if (!virtual) return;
    const row = bodyRef.current?.querySelector("tr[data-row]");
    const measured = row instanceof HTMLElement ? row.offsetHeight : 0;
    if (measured > 0 && measured !== rowHeight) setRowHeight(measured);
  }, [virtual, rowHeight, sorted]);

  const { first, last } = rowWindow(sorted.length, scrollTop, viewport, rowHeight, {
    threshold: VIRTUALIZE_ABOVE,
    overscan: OVERSCAN,
  });
  const visible = sorted.slice(first, last);

  if (result.rows.length === 0) {
    return <p className="empty">No rows.</p>;
  }

  return (
    <>
      {result.rows.length > FILTER_ABOVE ? (
        <input
          className="table-filter"
          type="search"
          placeholder={`Filter ${result.rows.length} rows`}
          aria-label="Filter rows"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
        />
      ) : null}
      <div
        className="table-scroll"
        onScroll={
          virtual
            ? (event) => {
                const el = event.currentTarget;
                setScrollTop(el.scrollTop);
                setViewport(el.clientHeight);
              }
            : undefined
        }
        ref={
          virtual
            ? (el) => {
                if (el && viewport === 0) setViewport(el.clientHeight);
              }
            : undefined
        }
      >
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((index) => {
                const column = result.columns[index]!;
                const active = sortCol === index;
                const help = headerHelp(column, presentation?.[column.name]);
                return (
                  <th
                    key={column.name}
                    aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
                    className={
                      numericColumns.has(index) ? "numeric" : "text"
                    }
                  >
                    <button
                      type="button"
                      title={help ?? undefined}
                      className={help ? "has-help" : undefined}
                      onClick={() => {
                        if (active) setAsc(!asc);
                        else {
                          setSortCol(index);
                          setAsc(true);
                        }
                      }}
                    >
                      <span className="header-text">
                        {headerLabel(column, presentation?.[column.name])}
                      </span>
                      <span className="sort-arrow">
                        {active ? (asc ? "↑" : "↓") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {/* Spacers stand in for the rows above and below the window, so the
                scrollbar reflects the whole result while the DOM holds a screenful. */}
            {virtual && first > 0 ? (
              <tr aria-hidden="true" style={{ height: first * rowHeight }} />
            ) : null}
            {visible.map((row, i) => (
              <tr key={first + i} data-row="">
                {columns.map((index) => {
                  const column = result.columns[index]!;
                  const cell = formatCell(row[index], column);
                  const kind = kinds.get(index) ?? "text";
                  const linked = kind !== "text" || isHex(row[index]);
                  return (
                    <td
                      key={column.name}
                      className={numericColumns.has(index) ? "numeric" : "text"}
                      title={linked || cell.text === cell.exact ? undefined : cell.exact}
                    >
                      {linked && row[index] !== null && row[index] !== undefined ? (
                        <ValueCell
                          value={row[index]}
                          text={cell.text}
                          kind={kind}
                          full={presentation?.[column.name]?.full ?? false}
                          explorerUrl={explorerUrl}
                        />
                      ) : (
                        cell.text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {virtual && last < sorted.length ? (
              <tr
                aria-hidden="true"
                style={{ height: (sorted.length - last) * rowHeight }}
              />
            ) : null}
          </tbody>
        </table>
      </div>
      {needle && sorted.length === 0 ? <p className="empty">No rows match “{needle}”.</p> : null}
    </>
  );
}

function Kpi({
  result,
  columns,
  unit,
}: {
  result: QueryResultDoc;
  columns: number[];
  unit?: string;
}) {
  const index = columns[0];
  const row = result.rows[0];
  if (index === undefined || row === undefined) {
    return <p className="empty">No value.</p>;
  }
  const cell = formatCell(row[index], result.columns[index]!);
  return (
    <div className="kpi">
      <div
        className="kpi-value"
        title={cell.text === cell.exact ? undefined : cell.exact}
      >
        {cell.text}
      </div>
      {unit ? <div className="kpi-unit">{unit}</div> : null}
    </div>
  );
}

/** Hands the browser a file built in memory, without a round trip. */
function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function PanelActions({
  panel,
  result,
  columns,
}: {
  panel: DashboardPanelDoc;
  result: QueryResultDoc | null | undefined;
  columns: number[];
}) {
  const csv = result && !result.error && panel.chart !== "kpi" && result.rows.length > 0;
  const sql = sqlHref(panel.sql);
  if (!sql && !csv) return null;
  return (
    <div className="panel-actions">
      {sql ? (
        <a href={sql} target="_blank" rel="noopener" title="The SQL behind this panel">
          SQL
        </a>
      ) : null}
      {csv ? (
        <button
          type="button"
          title="Download the rows as CSV, with exact values"
          onClick={() =>
            download(`${panel.query}.csv`, toCsv(result.columns, result.rows, columns), "text/csv")
          }
        >
          CSV
        </button>
      ) : null}
    </div>
  );
}

function Panel({
  panel,
  result,
  explorerUrl,
  standsAlone,
}: {
  panel: DashboardPanelDoc;
  result: QueryResultDoc | null | undefined;
  explorerUrl: string | null;
  standsAlone: boolean;
}) {
  const columns = useMemo(
    () => (result ? visibleColumns(result.columns, panel.hide_columns) : []),
    [result, panel.hide_columns],
  );

  const body = (): React.ReactNode => {
    if (result === undefined) return <p className="empty">Loading…</p>;
    if (result === null) {
      return <p className="error-note">No result published for “{panel.query}”.</p>;
    }
    if (result.error) {
      return (
        <p className="error-note">
          {result.error.code}: {result.error.message}
        </p>
      );
    }
    if (columns.length === 0) {
      return <p className="empty">Every column is hidden.</p>;
    }
    if (panel.chart === "kpi") {
      return <Kpi result={result} columns={columns} unit={panel.unit} />;
    }
    if (panel.chart === "table") {
      return (
        <DataTable
          result={result}
          columns={columns}
          presentation={panel.columns}
          explorerUrl={explorerUrl}
        />
      );
    }
    return (
      <Chart result={result} kind={panel.chart} columns={columns} presentation={panel.columns} />
    );
  };

  return (
    <section
      className={`panel span-${panel.span ?? "half"}${standsAlone ? " natural-height" : ""}`}
    >
      <header className="panel-head">
        <div className="panel-title">
          <h3>{panel.title ?? panel.query}</h3>
          <PanelActions panel={panel} result={result} columns={columns} />
        </div>
        {panel.description ? <p>{panel.description}</p> : null}
      </header>
      {body()}
    </section>
  );
}

function Provenance({ release }: { release: ReleaseDoc }) {
  const chips: React.ReactNode[] = [];
  const freshness = release.freshness;

  if (freshness?.kind === "chain" && freshness.data_through) {
    const { block, timestamp } = freshness.data_through;
    const ago = relativeTime(timestamp);
    chips.push(
      <Chip
        key="through"
        label="data through"
        value={`block ${block.toLocaleString()}${ago ? ` · ${ago}` : ""}`}
        tone="good"
        title={timestamp ?? undefined}
      />,
    );
    const checked = relativeTime(freshness.indexed_at);
    if (checked) {
      chips.push(
        <Chip
          key="indexed"
          label="indexed"
          value={checked}
          title={freshness.indexed_at ?? undefined}
        />,
      );
    }
  } else if (freshness) {
    // No chain provenance to offer, so name what this timestamp actually is
    // rather than dressing a file mtime up as freshness.
    chips.push(
      <Chip
        key="mtime"
        label="snapshot file"
        value={relativeTime(freshness.snapshot_mtime) ?? freshness.snapshot_mtime}
        title={freshness.snapshot_mtime}
      />,
    );
  }

  if (release.finality) {
    chips.push(
      <Chip
        key="finality"
        label="finality"
        value={
          release.finality.policy === "confirmation_depth"
            ? `${release.finality.depth} confirmations`
            : release.finality.policy
        }
      />,
    );
  }

  for (const coverage of release.coverage) {
    chips.push(
      <Chip
        key={`cov-${coverage.source_id}`}
        label={coverage.source_id}
        value={`${coverage.start_block.toLocaleString()}–${coverage.end_block.toLocaleString()} ${coverage.status}`}
        tone={coverage.status === "complete" ? "good" : "warn"}
      />,
    );
  }

  chips.push(<Chip key="mode" label="mode" value={release.mode.replace(/_/g, " ")} />);
  if (release.content_digest) {
    chips.push(
      <Chip
        key="digest"
        label="release"
        value={release.content_digest.slice(0, 12)}
        title={release.content_digest}
      />,
    );
  }
  return <div className="chips">{chips}</div>;
}

export function App() {
  const [release, setRelease] = useState<ReleaseDoc | null>(null);
  const [dashboards, setDashboards] = useState<DashboardDoc[]>([]);
  const [results, setResults] = useState<Record<string, QueryResultDoc | null>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rel = await fetchJson<ReleaseDoc>("release.json");
        if (cancelled) return;
        setRelease(rel);

        const [docs, entries] = await Promise.all([
          Promise.all(
            rel.dashboards.map((id) =>
              fetchJson<DashboardDoc>(`dashboards/${id}.json`),
            ),
          ),
          Promise.all(
            rel.queries.map(async (id) => {
              try {
                return [id, await fetchJson<QueryResultDoc>(`results/${id}.json`)] as const;
              } catch {
                return [id, null] as const;
              }
            }),
          ),
        ]);
        if (cancelled) return;
        setDashboards(docs);
        setResults(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <main className="app">
        <p className="error-note">Failed to load release: {loadError}</p>
      </main>
    );
  }
  if (!release) {
    // A cold object-store edge can take seconds to answer; a bare line of text
    // reads as a broken page while it does.
    return (
      <main className="app" aria-busy="true">
        <div className="skeleton skeleton-title" />
        <div className="chips">
          <div className="skeleton skeleton-chip" />
          <div className="skeleton skeleton-chip" />
          <div className="skeleton skeleton-chip" />
        </div>
        <div className="panel-grid" style={{ marginTop: "2.25rem" }}>
          <div className="skeleton skeleton-panel" />
          <div className="skeleton skeleton-panel" />
        </div>
        <p className="empty">Loading release…</p>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="masthead">
        <h1>{release.project_id}</h1>
        <Provenance release={release} />
      </header>

      {dashboards.length === 0 ? (
        <p className="empty">This release has no dashboards.</p>
      ) : null}

      {dashboards.map((dash) => (
        <section key={dash.dashboard_id} className="dashboard">
          <div className="dashboard-head">
            <h2>{dash.title}</h2>
            {dash.description ? <p>{dash.description}</p> : null}
          </div>
          <div className="panel-grid">
            {(() => {
              const alone = kpiStandsAlone(dash.panels);
              return dash.panels.map((panel, i) => (
                <Panel
                  key={i}
                  panel={panel}
                  result={results[panel.query]}
                  explorerUrl={dash.explorer_url ?? null}
                  standsAlone={alone[i] ?? false}
                />
              ));
            })()}
          </div>
        </section>
      ))}

      <footer className="colophon">
        Built by{" "}
        <a className="brand" href={CHAINPLOT_REPO_URL} rel="noopener">
          Chainplot
        </a>{" "}
        · {release.mode.replace(/_/g, " ")} ·{" "}
        <time dateTime={release.generated_at}>{release.generated_at}</time>
        {" · "}
        {release.mode === "results_only" ? (
          <>results only: the dataset is not published, so this release cannot be recomputed</>
        ) : (
          <a href={FORK_HOWTO_URL} rel="noopener">
            fork this release and recompute it
          </a>
        )}
      </footer>
    </main>
  );
}
