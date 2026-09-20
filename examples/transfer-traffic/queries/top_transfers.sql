-- No projected sort column: cp_sortkey() is applied in ORDER BY, so the
-- 78-digit key never reaches the dashboard.
select
  value,
  tx_hash,
  block_number
from usdc
order by cp_sortkey(value) desc
limit 10
