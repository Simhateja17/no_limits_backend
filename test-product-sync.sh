#!/bin/bash
# Replace with your actual client ID and auth token
curl -X POST http://localhost:3001/api/integrations/product-sync/client/YOUR_CLIENT_ID/full-sync \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -H "Content-Type: application/json"
