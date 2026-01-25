#!/bin/bash

# Quick Order Test Runner
# Simplified wrapper for bulk-create-orders-with-real-products.ts

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values
COUNT=10
DELAY=1000
PLATFORM="both"
DRY_RUN=""

# Function to print usage
usage() {
    echo -e "${BLUE}Quick Order Test Runner${NC}"
    echo ""
    echo "Usage: ./quick-order-test.sh [options]"
    echo ""
    echo "Options:"
    echo "  -c, --count <n>       Number of orders per platform (default: 10)"
    echo "  -d, --delay <ms>      Delay between orders in ms (default: 1000)"
    echo "  -p, --platform <type> Platform: shopify, woocommerce, both (default: both)"
    echo "  -n, --dry-run         Test without creating orders"
    echo "  -h, --help            Show this help"
    echo ""
    echo "Examples:"
    echo "  ./quick-order-test.sh                              # 10 orders for both platforms"
    echo "  ./quick-order-test.sh -c 5 -p shopify              # 5 Shopify orders"
    echo "  ./quick-order-test.sh -c 20 -d 500                 # 20 orders with 500ms delay"
    echo "  ./quick-order-test.sh -n                           # Dry run"
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -c|--count)
            COUNT="$2"
            shift 2
            ;;
        -d|--delay)
            DELAY="$2"
            shift 2
            ;;
        -p|--platform)
            PLATFORM="$2"
            shift 2
            ;;
        -n|--dry-run)
            DRY_RUN="--dry-run"
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# Print configuration
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}           Quick Order Test Configuration${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "  Orders per platform: ${GREEN}${COUNT}${NC}"
echo -e "  Delay:               ${GREEN}${DELAY}ms${NC}"
echo -e "  Platform:            ${GREEN}${PLATFORM}${NC}"
if [ -n "$DRY_RUN" ]; then
    echo -e "  Mode:                ${YELLOW}DRY RUN (no orders created)${NC}"
else
    echo -e "  Mode:                ${GREEN}LIVE (will create orders)${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Check if .env exists
if [ ! -f "${SCRIPT_DIR}/../../.env" ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Please create backend/.env with DATABASE_URL and ENCRYPTION_KEY"
    exit 1
fi

# Run the script
cd "${SCRIPT_DIR}/../.."
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts \
    --count "$COUNT" \
    --delay "$DELAY" \
    --platform "$PLATFORM" \
    $DRY_RUN

echo ""
echo -e "${GREEN}✓ Test completed!${NC}"
