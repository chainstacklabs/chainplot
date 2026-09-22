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
  columnLabel,
  compareValues,
  formatCell,
  isNumericColumn,
  relativeTime,
  rowWindow,
  toChartNumber,
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

function Chart({
  result,
  kind,
  columns,
}: {
  result: QueryResultDoc;
  kind: ChartKind;
  columns: number[];
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
          axisLabel: { color: text, hideOverlap: true },
        },
        yAxis: {
          type: "value",
          splitLine: { lineStyle: { color: grid } },
          axisLabel: { color: text },
        },
        series: seriesIndexes.map((index) => {
          const column = result.columns[index]!;
          return {
            name: columnLabel(column),
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
  }, [result, kind, columns, el]);

  return <div className="chart" ref={setEl} />;
}

// Below this, rendering every row costs nothing and avoids the measurement
// dance entirely.
const VIRTUALIZE_ABOVE = 200;
// Rows rendered beyond the viewport, so a fast scroll does not show gaps.
const OVERSCAN = 12;
// Only a starting guess: the real height is measured from the first render,
// so this constant and the stylesheet cannot drift apart.
const ASSUMED_ROW_HEIGHT = 33;

function DataTable({
  result,
  columns,
}: {
  result: QueryResultDoc;
  columns: number[];
}) {
  const [sortCol, setSortCol] = useState<number | null>(null);
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

  const sorted = useMemo(() => {
    if (sortCol === null) return result.rows;
    const rows = [...result.rows];
    rows.sort((a, b) => {
      const cmp = compareValues(a[sortCol], b[sortCol]);
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [result, sortCol, asc]);

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
              return (
                <th
                  key={column.name}
                  aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
                  className={
                    numericColumns.has(index)
                      ? column.raw_amount
                        ? "numeric raw"
                        : "numeric"
                      : "text"
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (active) setAsc(!asc);
                      else {
                        setSortCol(index);
                        setAsc(true);
                      }
                    }}
                  >
                    {columnLabel(column)}
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
                return (
                  <td
                    key={column.name}
                    className={numericColumns.has(index) ? "numeric" : "text"}
                    title={cell.text === cell.exact ? undefined : cell.exact}
                  >
                    {cell.text}
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

function Panel({
  panel,
  result,
}: {
  panel: DashboardPanelDoc;
  result: QueryResultDoc | null | undefined;
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
      return <DataTable result={result} columns={columns} />;
    }
    return <Chart result={result} kind={panel.chart} columns={columns} />;
  };

  return (
    <section className={`panel span-${panel.span ?? "half"}`}>
      <header className="panel-head">
        <h3>{panel.title ?? panel.query}</h3>
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
            {dash.panels.map((panel, i) => (
              <Panel key={i} panel={panel} result={results[panel.query]} />
            ))}
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
