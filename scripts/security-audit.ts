#!/usr/bin/env npx tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Audit Script
 *
 * Scans the codebase for potential IDOR (Insecure Direct Object Reference)
 * vulnerabilities by checking that all routes with user ID parameters
 * have proper authorization middleware.
 *
 * Run with: npx tsx scripts/security-audit.ts
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Vulnerabilities found
 */

import * as fs from 'fs';
import * as path from 'path';

interface RouteAuditResult {
    filePath: string;
    hasUserIdParam: boolean;
    paramName: string | null;
    hasAuthMiddleware: boolean;
    middlewareType: string | null;
    isVulnerable: boolean;
    firstLines: string;
}

// User ID parameter patterns in route paths
const USER_ID_PATTERNS = ['[user_id]', '[userId]', '[username]'];

// Authorization middleware patterns to look for
const AUTH_MIDDLEWARE_PATTERNS = [
    {
        pattern: /requireSelfOrAdmin\s*\(\s*['"`](\w+)['"`]\s*\)/,
        name: 'requireSelfOrAdmin',
    },
    { pattern: /requireAdmin\s*\(/, name: 'requireAdmin' },
    { pattern: /requireAuth\s*\(/, name: 'requireAuth' },
    { pattern: /requireGroups\s*\(/, name: 'requireGroups' },
    { pattern: /getUserRole\s*\(/, name: 'getUserRole (playlist-specific)' },
    // withMiddleware combinations
    {
        pattern: /withMiddleware\s*\(\s*requireAdmin/,
        name: 'withMiddleware(requireAdmin)',
    },
    {
        pattern: /withMiddleware\s*\(\s*requireAuth/,
        name: 'withMiddleware(requireAuth)',
    },
    {
        pattern: /withMiddleware\s*\(\s*requireSelfOrAdmin/,
        name: 'withMiddleware(requireSelfOrAdmin)',
    },
    // Inline permission checks (custom auth)
    {
        pattern: /if\s*\(\s*effectiveCurrentUser\s*!==\s*userId/,
        name: 'inline permission check',
    },
    {
        pattern: /if\s*\(\s*locals\.user\.username\s*!==/,
        name: 'inline user check',
    },
    // Re-exports from protected internal API
    {
        pattern: /export\s*\{[^}]*\}\s*from\s*['"]\.\.\/\.\.\//,
        name: 're-export from internal API',
    },
];

// Routes that are intentionally public or have custom auth
const ALLOWED_EXCEPTIONS: string[] = [
    // User avatars are intentionally public (profile pictures)
    '/api/image/user/[userId]/avatar',
    '/public-api/image/user/[userId]/avatar',
    // Re-exports that delegate to protected internal APIs
    '/public-api/playlists/[id]/members/[username]',
];

function findServerFiles(dir: string): string[] {
    const files: string[] = [];

    function walkDir(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                // Skip node_modules and hidden directories
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    walkDir(fullPath);
                }
            } else if (entry.name === '+server.ts' || entry.name === '+server.js') {
                files.push(fullPath);
            }
        }
    }

    walkDir(dir);
    return files;
}

function hasUserIdParamInPath(filePath: string): {
    hasParam: boolean;
    paramName: string | null;
} {
    const routePath = path.dirname(filePath);

    for (const pattern of USER_ID_PATTERNS) {
        if (routePath.includes(pattern)) {
            return { hasParam: true, paramName: pattern.slice(1, -1) }; // Remove brackets
        }
    }

    return { hasParam: false, paramName: null };
}

function checkAuthMiddleware(content: string): {
    hasAuth: boolean;
    middlewareType: string | null;
} {
    for (const { pattern, name } of AUTH_MIDDLEWARE_PATTERNS) {
        if (pattern.test(content)) {
            return { hasAuth: true, middlewareType: name };
        }
    }

    return { hasAuth: false, middlewareType: null };
}

function isException(filePath: string): boolean {
    const relativePath = filePath.replace(process.cwd(), '');
    return ALLOWED_EXCEPTIONS.some((exception) => relativePath.includes(exception));
}

function auditRoute(filePath: string): RouteAuditResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { hasParam, paramName } = hasUserIdParamInPath(filePath);
    const { hasAuth, middlewareType } = checkAuthMiddleware(content);

    // Get first 30 lines for context
    const firstLines = content.split('\n').slice(0, 30).join('\n');

    const isVulnerable = hasParam && !hasAuth && !isException(filePath);

    return {
        filePath,
        hasUserIdParam: hasParam,
        paramName,
        hasAuthMiddleware: hasAuth,
        middlewareType,
        isVulnerable,
        firstLines,
    };
}

function main() {
    const routesDir = path.join(process.cwd(), 'src/routes');

    if (!fs.existsSync(routesDir)) {
        console.error('Error: src/routes directory not found');
        console.error('Run this script from the project root directory');
        process.exit(1);
    }

    console.log('🔍 Security Audit: Scanning for IDOR vulnerabilities...\n');

    const serverFiles = findServerFiles(routesDir);
    const results = serverFiles.map(auditRoute);

    // Filter to routes with user ID params
    const userIdRoutes = results.filter((r) => r.hasUserIdParam);
    const vulnerableRoutes = results.filter((r) => r.isVulnerable);
    const protectedRoutes = userIdRoutes.filter((r) => !r.isVulnerable);

    // Report
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  SECURITY AUDIT REPORT: User ID Parameter Routes');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (vulnerableRoutes.length > 0) {
        console.log('🚨 POTENTIAL VULNERABILITIES FOUND:\n');

        for (const route of vulnerableRoutes) {
            const relativePath = route.filePath.replace(process.cwd(), '');
            console.log(`  ❌ ${relativePath}`);
            console.log(`     Parameter: ${route.paramName}`);
            console.log(`     Missing: requireSelfOrAdmin('${route.paramName}') or requireAdmin`);
            console.log('');
        }

        console.log('───────────────────────────────────────────────────────────────\n');
    }

    if (protectedRoutes.length > 0) {
        console.log('✅ PROTECTED ROUTES:\n');

        for (const route of protectedRoutes) {
            const relativePath = route.filePath.replace(process.cwd(), '');
            console.log(`  ✓ ${relativePath}`);
            console.log(`     Parameter: ${route.paramName}`);
            console.log(`     Protected by: ${route.middlewareType}`);
            console.log('');
        }

        console.log('───────────────────────────────────────────────────────────────\n');
    }

    // Summary
    console.log('SUMMARY:');
    console.log(`  Total server files scanned: ${serverFiles.length}`);
    console.log(`  Routes with user ID params: ${userIdRoutes.length}`);
    console.log(`  Protected routes: ${protectedRoutes.length}`);
    console.log(`  Vulnerable routes: ${vulnerableRoutes.length}`);
    console.log('');

    if (vulnerableRoutes.length > 0) {
        console.log('⚠️  ACTION REQUIRED: Fix the vulnerabilities above by adding:');
        console.log('');
        console.log('   import { requireSelfOrAdmin } from "$lib/server/middleware/auth";');
        console.log('');
        console.log('   export const GET = requireSelfOrAdmin("user_id")(async ({ params }) => {');
        console.log('     // ... handler code');
        console.log('   });');
        console.log('');
        process.exit(1);
    } else {
        console.log('✅ All user ID parameter routes are properly protected!');
        process.exit(0);
    }
}

main();
