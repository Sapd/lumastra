#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test runner for custom ESLint plugin rules
 *
 * Note: Using CommonJS require since ESLint RuleTester expects CommonJS modules
 */

const path = require('path');
const { execSync } = require('child_process');

console.log('Running ESLint plugin tests...\n');

const testFiles = [
    'no-custom-event-in-callback-prop.test.js',
    'require-validation-optional-chaining.test.js',
    'validate-callback-parameters.test.js',
    'no-empty-catch.test.js',
    'no-direct-sql-begin.test.js',
    'require-has-files-with-active-status.test.js',
    'no-unscoped-media-items.test.js',
    'no-unrestricted-access-outside-allowlist.test.js',
    'require-route-authz.test.js',
    'no-success-in-catch.test.js',
    'no-narrowing-media-type-cast.test.js',
    'no-hardcoded-api-path.test.js',
    'require-base-aware-navigation.test.js',
    'no-base-path-in-url.test.js',
    'no-bare-media-type-comparison.test.js',
    'no-comparator-on-narrowed-media-type.test.js',
    'no-inline-media-type-default.test.js',
    'no-compat-media-type-conversion-import.test.js',
    'no-absolute-vi-mock-path.test.js',
    'admin-actions-require-gate.test.js',
    'require-defs-ownership-gate.test.js',
    'no-bare-fetch-in-server.test.js',
    'no-locals-user-is-admin.test.js',
];

try {
    for (const testFile of testFiles) {
        console.log(`Running ${testFile}...`);
        execSync(`node ${path.join(__dirname, testFile)}`, {
            stdio: 'inherit',
            cwd: __dirname,
        });
    }

    console.log('\n✅ All ESLint plugin tests passed!');
    process.exit(0);
} catch {
    console.error('\n❌ Tests failed');
    process.exit(1);
}
