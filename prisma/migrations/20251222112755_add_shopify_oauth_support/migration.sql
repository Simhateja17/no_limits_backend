-- Add OAuth support for Shopify channels
-- Add authentication method tracking
ALTER TABLE channels ADD COLUMN IF NOT EXISTS auth_method TEXT;

-- Add OAuth state management for CSRF protection
ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_state TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_state_expiry TIMESTAMP;

-- Migrate existing Shopify channels to use custom_app method
UPDATE channels
SET auth_method = 'custom_app'
WHERE type = 'SHOPIFY' AND access_token IS NOT NULL AND auth_method IS NULL;

-- Add index for OAuth state lookups
CREATE INDEX IF NOT EXISTS idx_channels_oauth_state ON channels(oauth_state) WHERE oauth_state IS NOT NULL;
