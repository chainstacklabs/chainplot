-- cp_sortkey() is built in: it maps a decimal-string amount to a fixed-width
-- key whose lexicographic order is signed-numeric order. Ordering by the raw
-- column directly is refused, because "9" would sort after "10".
SELECT amount
FROM amounts
ORDER BY cp_sortkey(amount)
