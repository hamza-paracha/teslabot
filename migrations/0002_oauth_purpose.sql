ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'connect' CHECK(purpose IN ('connect', 'reconnect'));
