#!/bin/bash
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only


# Run tests in batches to prevent OOM errors
# Each batch runs independently with its own memory allocation

set -e

# Find all test files (excluding integration tests and iframe-analyzer)
TEST_FILES=$(find src -name "*.test.ts" ! -name "*.integration.test.ts" ! -name "iframe-analyzer.test.ts" | sort)

# Batch size - run this many test files at once
# Set to 1 to run each test file completely isolated (prevents OOM)
BATCH_SIZE=1

# Convert to array (portable way)
FILES_ARRAY=()
while IFS= read -r line; do
    FILES_ARRAY+=("$line")
done <<< "$TEST_FILES"

# Total files
TOTAL_FILES=${#FILES_ARRAY[@]}
echo "Found $TOTAL_FILES test files"
echo ""

# Calculate number of batches
BATCHES=$(( (TOTAL_FILES + BATCH_SIZE - 1) / BATCH_SIZE ))

FAILED=0

# Run tests in batches
for ((i=0; i<BATCHES; i++)); do
    START=$((i * BATCH_SIZE))
    END=$((START + BATCH_SIZE))

    if [ $END -gt $TOTAL_FILES ]; then
        END=$TOTAL_FILES
    fi

    # Build batch array
    BATCH_FILES=()
    for ((j=START; j<END && j<TOTAL_FILES; j++)); do
        BATCH_FILES+=("${FILES_ARRAY[$j]}")
    done

    echo "==================================================="
    echo "Batch $((i+1))/$BATCHES (files $((START+1))-$END)"
    echo "==================================================="

    # Run this batch
    if NODE_OPTIONS='--max-old-space-size=8192' npx vitest run "${BATCH_FILES[@]}"; then
        echo "✓ Batch $((i+1)) passed"
    else
        echo "✗ Batch $((i+1)) failed"
        FAILED=$((FAILED + 1))
    fi

    echo ""

    # Small delay to allow garbage collection
    sleep 1
done

echo ""
echo "==================================================="
echo "Summary: $((BATCHES - FAILED))/$BATCHES batches passed"
if [ $FAILED -gt 0 ]; then
    echo "⚠️  $FAILED batch(es) failed"
    exit 1
else
    echo "✓ All tests passed!"
fi
