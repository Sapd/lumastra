// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: validate-callback-parameters
 *
 * Detects callback invocations without validation in development mode.
 * Prevents silent type mismatches when callbacks receive unexpected parameter types.
 *
 * Problem Pattern:
 * ```typescript
 * export let onclick: (item: MediaItem) => void;
 *
 * function handleClick(item: MediaItem) {
 *   onclick(item);  // No validation
 * }
 * ```
 *
 * Suggests adding validateCallback() wrapper for runtime safety.
 *
 * @see docs/dev/lint-rules/callback-types.md
 */

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Require validation when invoking callback props with complex types',
            category: 'Best Practices',
            recommended: false, // Warn level, not error
        },
        messages: {
            missingValidation:
                'Callback prop "{{propName}}" invoked without validation. ' +
                'Consider using validateCallback() to catch type mismatches in development.',
            suggestValidation:
                'Add: validateCallback({{propName}}, {{param}}, is{{typeName}}, "{{propName}} expects {{typeName}}");',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    requireValidation: {
                        type: 'boolean',
                        default: true,
                    },
                    exemptBuiltIns: {
                        type: 'boolean',
                        default: true,
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const options = context.options[0] || {};
        const requireValidation = options.requireValidation !== false;
        const exemptBuiltIns = options.exemptBuiltIns !== false;

        if (!requireValidation) return {};

        // Track callback props exported from the component
        const callbackProps = new Map();

        // Built-in event handlers to exempt
        const builtInHandlers = new Set([
            'addEventListener',
            'removeEventListener',
            'setTimeout',
            'setInterval',
            'requestAnimationFrame',
            'queueMicrotask',
            'then',
            'catch',
            'finally',
        ]);

        /**
         * Checks if a prop is a callback type
         */
        function isCallbackProp(node) {
            if (!node.id || !node.id.typeAnnotation) return false;

            const typeAnnotation = node.id.typeAnnotation.typeAnnotation;

            // Must be a function type or union including function
            if (typeAnnotation.type === 'TSFunctionType') return true;

            if (typeAnnotation.type === 'TSUnionType') {
                return typeAnnotation.types.some(
                    (t) =>
                        t.type === 'TSFunctionType' ||
                        (t.type === 'TSParenthesizedType' &&
                            t.typeAnnotation.type === 'TSFunctionType'),
                );
            }

            return false;
        }

        /**
         * Extract type name from parameter annotation
         * e.g., (item: MediaItem) => MediaItem
         */
        function extractParamType(functionType) {
            if (!functionType.params || functionType.params.length === 0) {
                return null;
            }

            const firstParam = functionType.params[0];
            if (!firstParam.typeAnnotation) return null;

            const sourceCode = context.sourceCode;
            const paramType = firstParam.typeAnnotation.typeAnnotation;
            let typeText = sourceCode.getText(paramType);

            // Clean up the type text
            typeText = typeText.replace(/^TSTypeReference:/, '');
            typeText = typeText.replace(/CustomEvent<(.+)>/, '$1');

            // Extract base type name (remove generics, arrays, etc.)
            const match = typeText.match(/^(\w+)/);
            return match ? match[1] : typeText;
        }

        /**
         * Track exported callback props
         */
        function trackCallbackProp(node) {
            // Must be an export declaration
            if (!node.parent || node.parent.type !== 'ExportNamedDeclaration') {
                return;
            }

            if (
                node.type !== 'VariableDeclaration' ||
                !node.declarations ||
                node.declarations.length === 0
            ) {
                return;
            }

            const declaration = node.declarations[0];
            if (!isCallbackProp(declaration)) return;

            const propName = declaration.id.name;

            // Store callback prop info
            let functionType = declaration.id.typeAnnotation.typeAnnotation;

            if (functionType.type === 'TSUnionType') {
                functionType = functionType.types.find(
                    (t) =>
                        t.type === 'TSFunctionType' ||
                        (t.type === 'TSParenthesizedType' &&
                            t.typeAnnotation.type === 'TSFunctionType'),
                );

                if (functionType && functionType.type === 'TSParenthesizedType') {
                    functionType = functionType.typeAnnotation;
                }
            }

            const paramType = extractParamType(functionType);

            callbackProps.set(propName, {
                node: declaration,
                paramType,
            });
        }

        /**
         * Check if callback invocation has validation
         */
        function checkCallbackInvocation(node) {
            // Check if this is a call to a callback prop
            const callee = node.callee;
            let callbackName;

            // Handle optional chaining: onclick?.()
            if (callee.type === 'ChainExpression') {
                if (callee.expression.type === 'Identifier') {
                    callbackName = callee.expression.name;
                } else if (callee.expression.type === 'MemberExpression') {
                    callbackName = callee.expression.property.name;
                }
            }
            // Handle direct call: onclick()
            else if (callee.type === 'Identifier') {
                callbackName = callee.name;
            }
            // Handle member expression: this.onclick()
            else if (callee.type === 'MemberExpression') {
                callbackName = callee.property.name;
            }

            if (!callbackName || !callbackProps.has(callbackName)) {
                return;
            }

            // Exempt built-in handlers
            if (exemptBuiltIns && builtInHandlers.has(callbackName)) {
                return;
            }

            // Check if this call is wrapped in validateCallback()
            const parent = node.parent;
            if (
                parent &&
                parent.type === 'ExpressionStatement' &&
                parent.parent &&
                parent.parent.type === 'BlockStatement'
            ) {
                const statements = parent.parent.body;
                const currentIndex = statements.indexOf(parent);

                // Check if previous statement is a validateCallback call
                if (currentIndex > 0) {
                    const prevStatement = statements[currentIndex - 1];
                    if (
                        prevStatement.type === 'ExpressionStatement' &&
                        prevStatement.expression.type === 'CallExpression'
                    ) {
                        const prevCall = prevStatement.expression;
                        if (
                            prevCall.callee.name === 'validateCallback' &&
                            prevCall.arguments.length > 0
                        ) {
                            const sourceCode = context.sourceCode;
                            const firstArg = sourceCode.getText(prevCall.arguments[0]);

                            // If first argument matches our callback, it's validated
                            if (firstArg === callbackName) {
                                return;
                            }
                        }
                    }
                }
            }

            const callbackInfo = callbackProps.get(callbackName);
            const sourceCode = context.sourceCode;
            const paramName =
                node.arguments.length > 0 ? sourceCode.getText(node.arguments[0]) : 'value';

            context.report({
                node,
                messageId: 'missingValidation',
                data: {
                    propName: callbackName,
                    param: paramName,
                    typeName: callbackInfo.paramType || 'unknown',
                },
            });
        }

        return {
            VariableDeclaration: trackCallbackProp,
            CallExpression: checkCallbackInvocation,
        };
    },
};
