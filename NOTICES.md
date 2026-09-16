# Upstream notices

Chainplot is MIT-licensed (see `LICENSE`). It bundles or depends on the
following upstream software at runtime; their licenses govern those
components, not the datasets you publish.

| Component | License | Use |
|---|---|---|
| [rindexer](https://github.com/joshstevens19/rindexer) | MIT (pinned binary from the upstream image) | EVM event indexing |
| [DuckDB](https://duckdb.org) via `@duckdb/node-api` | MIT | Snapshot queries and Parquet export |
| [React](https://react.dev) | MIT | Viewer |
| [ECharts](https://echarts.apache.org) | Apache-2.0 | Viewer charts |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 | S3-compatible publish |
| [pg](https://github.com/brianc/node-postgres) | MIT | Advisory lock, coverage cursor reads |
| [ajv](https://github.com/ajv-validator/ajv), [yaml](https://github.com/eemeli/yaml), [commander](https://github.com/tj/commander.js), [Vite](https://vitejs.dev) | MIT | Schema validation, YAML, CLI, viewer build |

## Dataset licenses are separate

The software license (MIT) does not cover the data you publish. Every publish
target requires an explicit `dataset_license` field; it is recorded with the
release. Choose and document the license that applies to your dataset.
