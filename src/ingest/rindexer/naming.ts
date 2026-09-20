// rindexer names its Postgres objects by snake_casing the manifest, contract
// and event names it is given. Chainplot has to look those objects up, so it
// has to derive the very same names — lowercasing is not the same operation:
// `RelayERC20Deposit` lowercases to `relayerc20deposit` and snake_cases to
// `relay_erc_20_deposit`. Every current template uses `Transfer`, where the two
// coincide, which is how the difference stayed invisible.
//
// This is a port of rindexer's `camel_to_snake` (core/src/helpers/mod.rs,
// `camel_to_snake_advanced(s, false)`). Keep it byte-for-byte with upstream;
// the tests pin cases observed against a live rindexer database.

/** Max identifier length Postgres accepts; rindexer compacts beyond it. */
export const POSTGRES_IDENTIFIER_MAX = 63;

export function camelToSnake(s: string): string {
  let out = "";
  let previousWasUppercase = false;
  let previousWasDigit = false;
  let uppercaseRun = 0;

  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const isAlnum = /^[\p{L}\p{N}]$/u.test(c);
    if (!isAlnum && c !== "_") continue;

    if (c !== c.toLowerCase() && c === c.toUpperCase()) {
      // Uppercase letter. Split before it unless it continues an uppercase run
      // — except when the run ends here because a lowercase letter follows
      // (`ERC20Deposit` keeps `erc`, but `HTTPServer` splits to `http_server`).
      const next = chars[i + 1];
      const nextIsLower =
        next !== undefined && next !== next.toUpperCase() && next === next.toLowerCase();
      if (i > 0 && (!previousWasUppercase || nextIsLower)) {
        out += "_";
      }
      out += c.toLowerCase();
      previousWasUppercase = true;
      previousWasDigit = false;
      uppercaseRun += 1;
    } else if (/^[0-9]$/.test(c)) {
      // A digit run gets its own word, unless it directly follows a single
      // capital (`V2` stays `v2`) or an underscore.
      if (i > 0 && !previousWasDigit && !out.endsWith("_") && uppercaseRun !== 1) {
        out += "_";
      }
      out += c;
      previousWasUppercase = false;
      previousWasDigit = true;
      uppercaseRun = 0;
    } else {
      out += c;
      previousWasUppercase = false;
      previousWasDigit = false;
      uppercaseRun = 0;
    }
  }
  return out;
}

// rindexer derives table names from the manifest `name` (not the network):
// event table `{name}_{contract}.{event}`, cursor
// `rindexer_internal.{name}_{contract}_{event}`. renderConfig sets
// name = `chainplot_<networkName>`. Each component is snake_cased upstream.
export function manifestName(networkName: string): string {
  return camelToSnake(`chainplot_${networkName}`);
}

export function schemaName(networkName: string, contractName: string): string {
  return `${manifestName(networkName)}_${camelToSnake(contractName)}`;
}

/** Bare (schema-less) cursor table name, before rindexer's length compaction. */
export function cursorTableBareName(
  networkName: string,
  contractName: string,
  event: string,
): string {
  return `${schemaName(networkName, contractName)}_${camelToSnake(event)}`;
}

export function cursorTableName(
  networkName: string,
  contractName: string,
  event: string,
): string {
  return `rindexer_internal.${cursorTableBareName(networkName, contractName, event)}`;
}

export function eventTableName(
  networkName: string,
  contractName: string,
  event: string,
): string {
  return `${schemaName(networkName, contractName)}.${camelToSnake(event)}`;
}

/**
 * Past 63 characters rindexer rewrites the cursor table name with a keccak
 * suffix, and Postgres silently truncates the schema. Neither can be looked
 * up by the derivation above, so the combination is refused up front — at
 * plan time, before a single block is indexed — with the fix spelled out.
 */
export function tableNameOverflow(
  networkName: string,
  contractName: string,
  event: string,
): string | null {
  const cursor = cursorTableBareName(networkName, contractName, event);
  const schema = schemaName(networkName, contractName);
  const longest = cursor.length >= schema.length ? cursor : schema;
  if (longest.length <= POSTGRES_IDENTIFIER_MAX) return null;
  return (
    `table name ${longest} is ${longest.length} characters; Postgres allows ` +
    `${POSTGRES_IDENTIFIER_MAX}. Shorten the source id (${contractName}) — ` +
    `it and the event name ${event} make up the excess`
  );
}
