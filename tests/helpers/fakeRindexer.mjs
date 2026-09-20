#!/usr/bin/env node
// Fake rindexer for tests. Modes via FAKE_RINDEXER_ENV (JSON in argv[2]).
// Usage: node fakeRindexer.mjs start -p <dir> indexer
const mode = process.env.FAKE_RINDEXER_MODE ?? "complete";

if (mode === "complete") {
  process.stdout.write("Historical indexing completed\n");
  // health-server behavior: never exits on its own
  setInterval(() => {}, 1000);
} else if (mode === "exit") {
  process.stdout.write("starting up\n");
  process.exit(3);
} else {
  // hang: never prints the completed line
  setInterval(() => {}, 1000);
}
