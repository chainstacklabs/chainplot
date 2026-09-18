import { describe, expect, it } from "vitest";
import {
  camelToSnake,
  cursorTableName,
  eventTableName,
  tableNameOverflow,
} from "../../src/ingest/rindexer/naming.js";

// rindexer creates the tables; chainplot only looks them up. Every template
// uses `Transfer`, where lowercase and snake_case coincide, so the difference
// was invisible until a project used a multi-word event: rows landed in
// `relay_erc_20_deposit` while apply asked for `relayerc20deposit`.
describe("camelToSnake follows rindexer's rule exactly", () => {
  it.each([
    ["Transfer", "transfer"],
    // Observed on a live rindexer database (the case that surfaced the bug).
    ["RelayERC20Deposit", "relay_erc_20_deposit"],
    ["UserOperationEvent", "user_operation_event"],
    ["TransferShares", "transfer_shares"],
    // An uppercase run ends where a lowercase letter follows.
    ["HTTPServer", "http_server"],
    ["ERC20Transfer", "erc_20_transfer"],
    // A digit after a single capital attaches to it; after a run it does not.
    ["SwapV2", "swap_v2"],
    ["PoolV3Created", "pool_v3_created"],
    // Source ids are lowercase already, but digits still split.
    ["usdc", "usdc"],
    ["usdc2", "usdc_2"],
    ["erc20dep", "erc_20dep"],
    // Underscores are kept and never doubled.
    ["chainplot_chainplot_1", "chainplot_chainplot_1"],
    ["already_snake", "already_snake"],
  ])("%s → %s", (input, expected) => {
    expect(camelToSnake(input)).toBe(expected);
  });

  it("drops characters rindexer drops", () => {
    expect(camelToSnake("Weird-Name")).toBe("weird_name");
  });
});

describe("table names", () => {
  it("snake_cases the contract and the event, in both tables", () => {
    expect(eventTableName("chainplot_1", "erc20dep", "RelayERC20Deposit")).toBe(
      "chainplot_chainplot_1_erc_20dep.relay_erc_20_deposit",
    );
    expect(cursorTableName("chainplot_1", "erc20dep", "RelayERC20Deposit")).toBe(
      "rindexer_internal.chainplot_chainplot_1_erc_20dep_relay_erc_20_deposit",
    );
  });

  it("is unchanged for the single-word names every template uses", () => {
    expect(eventTableName("chainplot_1", "usdc", "Transfer")).toBe(
      "chainplot_chainplot_1_usdc.transfer",
    );
  });
});

// Past 63 characters rindexer compacts the cursor table name with a hash and
// Postgres truncates the schema; neither can be derived, so the combination is
// refused before anything is indexed.
describe("tableNameOverflow", () => {
  it("accepts names that fit", () => {
    expect(tableNameOverflow("chainplot_1", "usdc", "Transfer")).toBeNull();
  });

  it("names the excess when the cursor table would not fit", () => {
    const message = tableNameOverflow(
      "chainplot_1",
      "a_thirty_character_source_id_x",
      "SomeVeryLongEventName",
    );
    expect(message).toMatch(/63/);
    expect(message).toMatch(/a_thirty_character_source_id_x/);
    expect(message).toMatch(/SomeVeryLongEventName/);
  });
});
