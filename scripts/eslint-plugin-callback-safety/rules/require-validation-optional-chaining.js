// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: require-validation-optional-chaining
 *
 * Detects optional chaining (?.) in critical contexts where undefined would cause
 * silent failures (e.g., fetch URLs, API calls, database queries).
 *
 * Problem Pattern:
 * ```typescript
 * const id = item?.tmdbId;  // Could be undefined
 * fetch(`/api/data/${id}`);  // id = "undefined" in URL string!
 * ```
 *
 * Suggests using requireValue() or explicit null checks instead.
 *
 * @see docs/dev/lint-rules/callback-types.md
 */

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require validation when using optional chaining in critical contexts',
            category: 'Possible Errors',
            recommended: true,
        },
        messages: {
            unsafeOptionalChaining:
                'Optional chaining used in critical context ({{context}}). ' +
                'Value could be undefined, causing silent failures. ' +
                'Use requireValue() or explicit null check instead.',
            suggestRequireValue:
                'Consider: const {{varName}} = requireValue({{expression}}, "{{varName}} must be defined");',
            suggestNullCheck:
                'Consider: if (!{{expression}}) throw new Error("{{varName}} must be defined");',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    criticalContexts: {
                        type: 'array',
                        items: { type: 'string' },
                        default: ['fetch', 'Request', 'URL', 'new URL'],
                    },
                    suggestHelper: {
                        type: 'string',
                        default: 'requireValue',
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const options = context.options[0] || {};
        const criticalContexts = options.criticalContexts || ['fetch', 'Request', 'URL', 'new URL'];
        // Future enhancement: const suggestHelper = options.suggestHelper || 'requireValue';

        // Track variables assigned from optional chaining
        const optionalChainVars = new Map();

        /**
         * Checks if an expression uses optional chaining
         */
        function usesOptionalChaining(node) {
            if (!node) return false;

            // Direct optional chaining
            if (node.type === 'ChainExpression' && node.expression.optional) {
                return true;
            }

            // Check if it references a variable that was assigned from optional chaining
            if (node.type === 'Identifier' && optionalChainVars.has(node.name)) {
                return true;
            }

            // Recursively check child nodes
            if (node.type === 'MemberExpression' || node.type === 'CallExpression') {
                return usesOptionalChaining(node.object) || usesOptionalChaining(node.callee);
            }

            return false;
        }

        /**
         * Extracts variable name from optional chaining expression
         */
        function getVariableName(node) {
            const sourceCode = context.sourceCode;
            let text = sourceCode.getText(node);

            // Remove optional chaining operators for display
            text = text.replace(/\?\.?/g, '.');

            return text;
        }

        /**
         * Checks if a template literal contains unsafe optional chaining
         */
        function checkTemplateLiteral(node, contextName) {
            if (!node.expressions) return;

            for (const expression of node.expressions) {
                if (usesOptionalChaining(expression)) {
                    const sourceCode = context.sourceCode;
                    const expressionText = sourceCode.getText(expression);
                    const varName = getVariableName(expression);

                    context.report({
                        node: expression,
                        messageId: 'unsafeOptionalChaining',
                        data: {
                            context: contextName,
                            varName,
                            expression: expressionText,
                        },
                    });
                }
            }
        }

        /**
         * Checks if arguments to critical functions contain unsafe optional chaining
         */
        function checkCallExpression(node) {
            if (!node.callee) return;

            const sourceCode = context.sourceCode;
            const calleeName = sourceCode.getText(node.callee);

            // Check if this is a critical context function
            const matchedContext = criticalContexts.find((ctx) => calleeName.includes(ctx));

            if (!matchedContext) return;

            // Check all arguments
            for (const arg of node.arguments) {
                // Template literals in fetch/URL calls
                if (arg.type === 'TemplateLiteral') {
                    checkTemplateLiteral(arg, matchedContext);
                }
                // Direct optional chaining in arguments
                else if (usesOptionalChaining(arg)) {
                    const expressionText = sourceCode.getText(arg);
                    const varName = getVariableName(arg);

                    context.report({
                        node: arg,
                        messageId: 'unsafeOptionalChaining',
                        data: {
                            context: matchedContext,
                            varName,
                            expression: expressionText,
                        },
                    });
                }
            }
        }

        /**
         * Track variable declarations using optional chaining
         */
        function trackOptionalChainVariable(node) {
            if (node.type !== 'VariableDeclarator' || !node.init) return;

            if (usesOptionalChaining(node.init)) {
                if (node.id.type === 'Identifier') {
                    const sourceCode = context.sourceCode;
                    optionalChainVars.set(node.id.name, {
                        expression: sourceCode.getText(node.init),
                        node: node.init,
                    });
                }
            }
        }

        /**
         * Check new URL() calls
         */
        function checkNewExpression(node) {
            if (!node.callee) return;

            const sourceCode = context.sourceCode;
            const constructorName = sourceCode.getText(node.callee);

            if (constructorName === 'URL' || constructorName === 'Request') {
                // Check constructor arguments
                for (const arg of node.arguments) {
                    if (arg.type === 'TemplateLiteral') {
                        checkTemplateLiteral(arg, `new ${constructorName}`);
                    } else if (usesOptionalChaining(arg)) {
                        const expressionText = sourceCode.getText(arg);
                        const varName = getVariableName(arg);

                        context.report({
                            node: arg,
                            messageId: 'unsafeOptionalChaining',
                            data: {
                                context: `new ${constructorName}`,
                                varName,
                                expression: expressionText,
                            },
                        });
                    }
                }
            }
        }

        return {
            VariableDeclarator: trackOptionalChainVariable,
            CallExpression: checkCallExpression,
            NewExpression: checkNewExpression,
        };
    },
};
