-- One row per UTC day, combining both datasets. Amounts stay decimal strings:
-- USDC fits HUGEINT comfortably, but the result is cast straight back to text
-- so nothing downstream sees a narrowed numeric type.
SELECT
  d,
  sum(minted)::VARCHAR  AS minted,
  sum(burned)::VARCHAR  AS burned,
  sum(mint_events)      AS mint_events,
  sum(burn_events)      AS burn_events
FROM (
  SELECT date_trunc('day', block_timestamp) AS d,
         value::HUGEINT AS minted, 0::HUGEINT AS burned, 1 AS mint_events, 0 AS burn_events
  FROM mint
  UNION ALL
  SELECT date_trunc('day', block_timestamp),
         0::HUGEINT, value::HUGEINT, 0, 1
  FROM burn
)
GROUP BY d
