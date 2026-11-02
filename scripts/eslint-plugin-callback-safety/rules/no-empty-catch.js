// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-empty-catch
 *
 * Prevents bare catch blocks that silently swallow errors without logging,
 * handling, or documenting why the error is intentionally ignored.
 *
 * Problem: try { doSomething(); } catch {}
 *
 * Fix options:
 * - Add a justification comment inside the catch block
 * - Add error logging (logger.warn / console.warn)
 * - Add error handling (return fallback, rethrow, etc.)
 */

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Require catch blocks to either use the error variable or include a justification comment',
            category: 'Best Practices',
            recommended: true,
        },
        schema: [],
        messages: {
            emptyCatch:
                'Empty catch block silently swallows errors. Either: (1) add error handling/logging, (2) add a descriptive comment explaining why the error is intentionally ignored, or (3) capture and use the error variable.',
            unusedCatchError:
                "Catch block captures error variable '{{name}}' but never uses it. Either use the variable for logging/handling, remove it and add a justification comment, or add a comment explaining why it's intentionally ignored.",
        },
    },
    create(context) {
        return {
            CatchClause(node) {
                const body = node.body;

                // If the catch body has statements that reference the error param, it's fine
                if (body.body.length > 0 && node.param) {
                    // Check if the error variable is actually used in the body
                    const paramName = node.param.type === 'Identifier' ? node.param.name : null;
                    if (paramName) {
                        const scope = context.sourceCode.getScope(node);
                        const variable = scope.variables.find((v) => v.name === paramName);
                        if (variable && variable.references.length > 0) {
                            // Error variable is used — this catch block has handling
                            return;
                        }
                    }
                }

                // If the body has actual statements (not just comments), it's doing something
                if (body.body.length > 0) {
                    return;
                }

                // Empty body — check for justification comments inside the catch block
                const sourceCode = context.sourceCode;
                const comments = sourceCode.getCommentsInside
                    ? sourceCode.getCommentsInside(body)
                    : [];

                // Also check for comments between the braces using token-based approach
                let hasComment = comments.length > 0;
                if (!hasComment) {
                    const openBrace = sourceCode.getFirstToken(body);
                    const closeBrace = sourceCode.getLastToken(body);
                    if (openBrace && closeBrace) {
                        const tokensBetween = sourceCode.getTokensBetween(openBrace, closeBrace, {
                            includeComments: true,
                        });
                        hasComment = tokensBetween.some(
                            (t) => t.type === 'Line' || t.type === 'Block',
                        );
                    }
                }

                if (hasComment) {
                    // Has a justification comment — acceptable
                    return;
                }

                // No param, no statements, no comments — bare catch {}
                if (!node.param) {
                    context.report({
                        node,
                        messageId: 'emptyCatch',
                    });
                    return;
                }

                // Has param but empty body and no comments
                const paramName = node.param.type === 'Identifier' ? node.param.name : null;
                if (paramName) {
                    context.report({
                        node,
                        messageId: 'unusedCatchError',
                        data: { name: paramName },
                    });
                } else {
                    context.report({
                        node,
                        messageId: 'emptyCatch',
                    });
                }
            },
        };
    },
};
