SELECT strftime(d, '%Y-%m-%d') AS day, mint_events, burn_events
FROM daily
ORDER BY d
