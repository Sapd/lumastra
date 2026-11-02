// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-custom-event-in-callback-prop
 *
 * Detects when a Svelte component prop is typed as CustomEvent<T> but the component
 * likely calls it with a plain value, causing silent runtime failures.
 *
 * Problem Pattern:
 * ```typescript
 * export let onclick: (event: CustomEvent<MediaItem>) => void;
 *
 * function handleClick(item: MediaItem) {
 *   onclick?.(item); // Passing MediaItem, not CustomEvent!
 * }
 * ```
 *
 * Parent receives MediaItem but types say CustomEvent, so accessing
 * event.detail causes undefined errors.
 *
 * @see docs/dev/lint-rules/callback-types.md
 */

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow CustomEvent type in callback props unless properly validated',
            category: 'Possible Errors',
            recommended: true,
        },
        messages: {
            customEventInCallback:
                'Callback prop "{{propName}}" should not use CustomEvent type. ' +
                'Either use a plain type (e.g., (item: {{dataType}}) => void), ' +
                'use a native event type (e.g., MouseEvent), or add validation with wrapCustomEventHandler().',
            customEventWithoutValidation:
                'Callback prop "{{propName}}" uses CustomEvent but lacks validation. ' +
                'Use wrapCustomEventHandler() to ensure runtime type safety.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    allowWithValidation: {
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
        const allowWithValidation = options.allowWithValidation !== false;

        /**
         * Extracts the data type from CustomEvent<DataType>
         * CustomEvent<MediaItem> -> MediaItem
         */
        function extractCustomEventType(typeAnnotation) {
            const sourceCode = context.sourceCode;
            const text = sourceCode.getText(typeAnnotation);

            // Match: CustomEvent<Something>
            const match = text.match(/CustomEvent<([^>]+)>/);
            return match ? match[1] : 'unknown';
        }

        /**
         * Checks if a prop declaration uses CustomEvent in callback signature
         */
        function checkPropDeclaration(node) {
            // We're looking for patterns like:
            // export let onclick: (event: CustomEvent<T>) => void;
            // export let onselect?: (e: CustomEvent<Data>) => void;

            // Must be an export declaration
            if (!node.parent || node.parent.type !== 'ExportNamedDeclaration') {
                return;
            }

            // Must be a variable declaration with type annotation
            if (
                node.type !== 'VariableDeclaration' ||
                !node.declarations ||
                node.declarations.length === 0
            ) {
                return;
            }

            const declaration = node.declarations[0];
            if (!declaration.id || !declaration.id.typeAnnotation) {
                return;
            }

            const propName = declaration.id.name;

            // Skip if not a callback prop (by convention, starts with 'on')
            if (!propName.startsWith('on')) {
                return;
            }

            const typeAnnotation = declaration.id.typeAnnotation.typeAnnotation;

            // Check if it's a function type
            if (typeAnnotation.type !== 'TSFunctionType' && typeAnnotation.type !== 'TSUnionType') {
                return;
            }

            // Handle union types (e.g., ((event: CustomEvent<T>) => void) | undefined)
            let functionType = typeAnnotation;
            if (typeAnnotation.type === 'TSUnionType') {
                functionType = typeAnnotation.types.find(
                    (t) =>
                        t.type === 'TSFunctionType' ||
                        (t.type === 'TSParenthesizedType' &&
                            t.typeAnnotation.type === 'TSFunctionType'),
                );

                if (!functionType) return;

                if (functionType.type === 'TSParenthesizedType') {
                    functionType = functionType.typeAnnotation;
                }
            }

            // Check function parameters for CustomEvent type
            if (!functionType.params || functionType.params.length === 0) {
                return;
            }

            const firstParam = functionType.params[0];
            if (!firstParam.typeAnnotation) {
                return;
            }

            const paramType = firstParam.typeAnnotation.typeAnnotation;
            const sourceCode = context.sourceCode;
            const paramTypeText = sourceCode.getText(paramType);

            // Check if parameter type includes CustomEvent
            if (paramTypeText.includes('CustomEvent')) {
                const dataType = extractCustomEventType(paramType);

                // Check if this is a validated CustomEvent handler
                const hasValidation =
                    declaration.init &&
                    sourceCode.getText(declaration.init).includes('wrapCustomEventHandler');

                if (allowWithValidation && hasValidation) {
                    // It's OK - has validation wrapper
                    return;
                }

                context.report({
                    node: declaration.id,
                    messageId: hasValidation
                        ? 'customEventWithoutValidation'
                        : 'customEventInCallback',
                    data: {
                        propName,
                        dataType,
                    },
                });
            }
        }

        return {
            VariableDeclaration: checkPropDeclaration,
        };
    },
};
