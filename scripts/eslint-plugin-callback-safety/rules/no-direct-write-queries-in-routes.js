// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint rule: no-direct-write-queries-in-routes
 *
 * Prevents route files (src/routes/**) from importing write-path query functions
 * directly. Routes must use service managers (WatchManager, SessionManager, etc.)
 * for write operations.
 *
 * Allowed in routes:
 * - Read-only query modules (browse, search, for-you-helpers, etc.)
 * - Service managers (watch-manager.service, activity.service, etc.)
 * - Middleware
 *
 * Forbidden in routes:
 * - watch-state.queries (updateWatchProgress, setWatchedStatus, batchSetWatchedStatus)
 * - play-sessions.queries (createPlaySession, updateHeartbeat, stopSession, killSession)
 * - viewing-sessions.queries write functions (if any)
 * - catalog-operations.queries write functions
 */
module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Prevent routes from importing write-path queries directly',
            category: 'Best Practices',
        },
        messages: {
            noDirectWriteQuery:
                'Routes should not import write-path queries directly. Use service managers instead (e.g., watchManager, sessionManager).',
        },
        schema: [],
    },
    create(context) {
        const filename = context.filename;

        // Only apply to route files
        if (!filename.includes('/src/routes/')) return {};
        // Exclude /j/ compat routes (they have special Jellyfin needs)
        if (filename.includes('/routes/j/')) return {};

        // Forbidden import patterns for routes
        const forbiddenPatterns = [
            /watch-state\.queries/,
            /watch-status\.queries/,
            /play-sessions\.queries/,
        ];

        // Specific forbidden function names from these modules
        const forbiddenFunctions = new Set([
            'updateWatchProgress',
            'setWatchedStatus',
            'batchSetWatchedStatus',
            'upsertFromJellyfinSync',
            'batchUpsertFromJellyfinSync',
            'upsertEpisodeWatched',
            'updateEpisodeUnwatched',
            'upsertMovieWatchedByJellyfinId',
            'updateMovieUnwatchedByJellyfinId',
            'markMediaWatched',
            'markMediaUnwatched',
            'updateHeartbeat',
            'upsertStreamPolicy',
            'stopSession',
            'killSession',
            'createPlaySession',
        ]);

        return {
            ImportDeclaration(node) {
                const source = node.source.value;
                if (typeof source !== 'string') return;

                // Check if importing from a forbidden query module
                const isForbiddenModule = forbiddenPatterns.some((p) => p.test(source));
                if (!isForbiddenModule) return;

                // Check if any imported specifier is a write function
                for (const specifier of node.specifiers) {
                    if (
                        specifier.type === 'ImportSpecifier' &&
                        forbiddenFunctions.has(specifier.imported.name)
                    ) {
                        context.report({
                            node: specifier,
                            messageId: 'noDirectWriteQuery',
                        });
                    }
                }
            },
        };
    },
};
