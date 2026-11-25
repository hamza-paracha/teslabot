CREATE TABLE alert_deliveries (id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE INDEX alert_deliveries_expires ON alert_deliveries(expires);
