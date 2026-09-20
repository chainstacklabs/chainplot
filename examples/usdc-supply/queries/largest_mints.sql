SELECT value, "to" AS recipient, block_number, strftime(block_timestamp, '%Y-%m-%d') AS day
FROM mint
ORDER BY cp_sortkey(value) DESC
LIMIT 15
