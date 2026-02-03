#!/bin/bash
#
# Quick test script for r.kutke@gmx.de webhook testing
# Usage: ./run-rkutke-test.sh [count] [--dry-run]
#

# WooCommerce API Credentials
export RKUTKE_WOOCOMMERCE_KEY="ck_8ec81f84468307f3851b60bbe91c85db5f7d5073"
export RKUTKE_WOOCOMMERCE_SECRET="cs_e34609c2a83ddf9d409b56fd324e7e48404161e9"

# WooCommerce store URL
export RKUTKE_WOOCOMMERCE_URL="https://sanit-ersatzteile.de"

# Default order count
COUNT="${1:-5}"

# Check if dry-run flag is passed
DRY_RUN=""
if [[ "$2" == "--dry-run" ]] || [[ "$1" == "--dry-run" ]]; then
    DRY_RUN="--dry-run"
    echo "🔍 Running in DRY RUN mode - no orders will be created"
fi

# Verify store URL is accessible
echo "🔍 Checking store URL: $RKUTKE_WOOCOMMERCE_URL"

echo "🚀 Starting webhook test for r.kutke@gmx.de"
echo "   Store: $RKUTKE_WOOCOMMERCE_URL"
echo "   Orders: $COUNT"
echo ""

# Run the test script
npx tsx "$(dirname "$0")/r-kutke-order-test.ts" --count "$COUNT" $DRY_RUN
