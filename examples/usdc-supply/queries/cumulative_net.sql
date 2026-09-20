SELECT
  strftime(d, '%Y-%m-%d') AS day,
  (sum(minted::HUGEINT - burned::HUGEINT) OVER (ORDER BY d))::VARCHAR AS cumulative_net
FROM daily
ORDER BY d
