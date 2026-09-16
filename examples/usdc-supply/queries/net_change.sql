SELECT (sum(minted::HUGEINT) - sum(burned::HUGEINT))::VARCHAR AS net_change FROM daily
