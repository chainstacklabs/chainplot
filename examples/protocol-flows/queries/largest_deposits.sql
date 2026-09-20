select
  wad,
  tx_hash
from weth_deposit
order by cp_sortkey(wad) desc
limit 5
