SELECT strftime(d, '%Y-%m-%d') AS day, minted, burned
FROM daily
ORDER BY d
