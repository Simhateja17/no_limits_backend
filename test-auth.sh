#!/bin/bash

echo "========================================="
echo "Testing Authentication Security"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BASE_URL="http://localhost:3001/api"

echo -e "${YELLOW}Test 1: Try to register without authentication (should fail)${NC}"
echo "curl -X POST $BASE_URL/auth/register"
curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"hacker@example.com","password":"password123","name":"Hacker","role":"SUPER_ADMIN"}' | jq .
echo ""
echo ""

echo -e "${YELLOW}Test 2: Login as Super Admin (should succeed)${NC}"
echo "curl -X POST $BASE_URL/auth/login"
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"superadmin@nolimits.com","password":"password123"}')
echo "$LOGIN_RESPONSE" | jq .
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken')
echo ""
echo ""

echo -e "${YELLOW}Test 3: Register new user as Super Admin (should succeed)${NC}"
echo "curl -X POST $BASE_URL/auth/register with Authorization header"
curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{"email":"newclient@example.com","password":"password123","name":"New Client","role":"CLIENT","companyName":"New Company"}' | jq .
echo ""
echo ""

echo -e "${YELLOW}Test 4: Login with non-existent user (should fail)${NC}"
echo "curl -X POST $BASE_URL/auth/login"
curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"nonexistent@example.com","password":"password123"}' | jq .
echo ""
echo ""

echo -e "${YELLOW}Test 5: Login as Client (should succeed)${NC}"
echo "curl -X POST $BASE_URL/auth/login"
CLIENT_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"papercrush@example.com","password":"password123"}')
echo "$CLIENT_RESPONSE" | jq .
CLIENT_TOKEN=$(echo "$CLIENT_RESPONSE" | jq -r '.accessToken')
echo ""
echo ""

echo -e "${YELLOW}Test 6: Client tries to register new user (should fail - insufficient permissions)${NC}"
echo "curl -X POST $BASE_URL/auth/register with Client token"
curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"email":"anotherclient@example.com","password":"password123","name":"Another Client","role":"CLIENT"}' | jq .
echo ""
echo ""

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}Check the backend server console logs to see the authentication/authorization messages!${NC}"
echo -e "${GREEN}=========================================${NC}"
