// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    assertDefined,
    assertType,
    isCustomEvent,
    isPlainEvent,
    isMouseEvent,
    isKeyboardEvent,
    validateCallback,
    wrapCustomEventHandler,
    wrapPlainEventHandler,
    requireValue,
    warnDeprecated,
    assertOneOf,
    devOnly,
    validateArray,
} from './runtime-validation';

describe('Runtime Validation Utilities', () => {
    describe('assertDefined', () => {
        it('does not throw when value is defined', () => {
            expect(() => assertDefined('value', 'Should be defined')).not.toThrow();
            expect(() => assertDefined(0, 'Should be defined')).not.toThrow();
            expect(() => assertDefined(false, 'Should be defined')).not.toThrow();
        });

        it('throws when value is undefined in dev mode', () => {
            expect(() => assertDefined(undefined, 'Value is required')).toThrow(
                'Assertion failed: Value is required',
            );
        });

        it('throws when value is null in dev mode', () => {
            expect(() => assertDefined(null, 'Value is required')).toThrow(
                'Assertion failed: Value is required',
            );
        });

        it('includes context in error message', () => {
            expect(() =>
                assertDefined(undefined, 'User required', {
                    userId: '123',
                    source: 'API',
                }),
            ).toThrow(/userId.*123/);
        });
    });

    describe('assertType', () => {
        it('does not throw when value matches type guard', () => {
            const isString = (val: unknown): val is string => typeof val === 'string';

            expect(() => assertType('test', isString, 'Should be string')).not.toThrow();
        });

        it('throws when value fails type guard', () => {
            const isString = (val: unknown): val is string => typeof val === 'string';

            expect(() => assertType(123, isString, 'Expected string')).toThrow('Expected string');
        });

        it('includes type information in error', () => {
            const isString = (val: unknown): val is string => typeof val === 'string';

            expect(() => assertType(123, isString, 'Expected string')).toThrow(/Received: number/);
        });

        it('includes context in error message', () => {
            const isString = (val: unknown): val is string => typeof val === 'string';

            expect(() =>
                assertType(123, isString, 'Expected string', {
                    fieldName: 'username',
                }),
            ).toThrow(/fieldName.*username/);
        });
    });

    describe('Type Guards', () => {
        describe('isCustomEvent', () => {
            it('returns true for CustomEvent', () => {
                const event = new CustomEvent('test', {
                    detail: { foo: 'bar' },
                });
                expect(isCustomEvent(event)).toBe(true);
            });

            it('returns false for plain Event', () => {
                const event = new Event('test');
                expect(isCustomEvent(event)).toBe(false);
            });

            it('returns false for MouseEvent', () => {
                const event = new MouseEvent('click');
                expect(isCustomEvent(event)).toBe(false);
            });

            it('returns false for non-events', () => {
                expect(isCustomEvent({})).toBe(false);
                expect(isCustomEvent('test')).toBe(false);
                expect(isCustomEvent(null)).toBe(false);
            });
        });

        describe('isPlainEvent', () => {
            it('returns true for plain Event', () => {
                const event = new Event('test');
                expect(isPlainEvent(event)).toBe(true);
            });

            it('returns true for MouseEvent (subclass of Event)', () => {
                const event = new MouseEvent('click');
                expect(isPlainEvent(event)).toBe(true);
            });

            it('returns false for non-events', () => {
                expect(isPlainEvent({})).toBe(false);
                expect(isPlainEvent('test')).toBe(false);
            });
        });

        describe('isMouseEvent', () => {
            it('returns true for MouseEvent', () => {
                const event = new MouseEvent('click');
                expect(isMouseEvent(event)).toBe(true);
            });

            it('returns false for plain Event', () => {
                const event = new Event('test');
                expect(isMouseEvent(event)).toBe(false);
            });

            it('returns false for KeyboardEvent', () => {
                const event = new KeyboardEvent('keydown');
                expect(isMouseEvent(event)).toBe(false);
            });
        });

        describe('isKeyboardEvent', () => {
            it('returns true for KeyboardEvent', () => {
                const event = new KeyboardEvent('keydown');
                expect(isKeyboardEvent(event)).toBe(true);
            });

            it('returns false for plain Event', () => {
                const event = new Event('test');
                expect(isKeyboardEvent(event)).toBe(false);
            });

            it('returns false for MouseEvent', () => {
                const event = new MouseEvent('click');
                expect(isKeyboardEvent(event)).toBe(false);
            });
        });
    });

    describe('validateCallback', () => {
        interface TestItem {
            id: string;
            name: string;
        }

        const isTestItem = (val: unknown): val is TestItem => {
            return (
                typeof val === 'object' &&
                val !== null &&
                'id' in val &&
                'name' in val &&
                typeof (val as TestItem).id === 'string' &&
                typeof (val as TestItem).name === 'string'
            );
        };

        it('does not throw when parameter matches type guard', () => {
            const callback = vi.fn();
            const item: TestItem = { id: '1', name: 'Test' };

            expect(() =>
                validateCallback(callback, item, isTestItem, 'Expected TestItem'),
            ).not.toThrow();
        });

        it('throws when parameter fails type guard', () => {
            const callback = vi.fn();
            const invalidItem = { id: '1' }; // Missing name

            expect(() =>
                validateCallback(callback, invalidItem, isTestItem, 'Expected TestItem'),
            ).toThrow('Expected TestItem');
        });

        it('does nothing when callback is undefined', () => {
            const item: TestItem = { id: '1', name: 'Test' };

            expect(() =>
                validateCallback(undefined, item, isTestItem, 'Expected TestItem'),
            ).not.toThrow();
        });

        it('includes callback name in error', () => {
            function namedCallback(_item: TestItem) {
                /* noop */
            }
            const invalidItem = { id: '1' } as unknown as TestItem; // Missing name property intentionally for test

            expect(() =>
                validateCallback(namedCallback, invalidItem, isTestItem, 'Expected TestItem'),
            ).toThrow(/namedCallback/);
        });
    });

    describe('wrapCustomEventHandler', () => {
        it('allows CustomEvent to pass through', () => {
            const handler = vi.fn();
            const wrappedHandler = wrapCustomEventHandler(handler);
            const event = new CustomEvent('test', { detail: { foo: 'bar' } });

            wrappedHandler(event);

            expect(handler).toHaveBeenCalledWith(event);
        });

        it('throws when receiving plain Event', () => {
            const handler = vi.fn();
            const wrappedHandler = wrapCustomEventHandler(handler);
            const event = new Event('test');

            // Type assertion needed for test (would be caught by TypeScript in real code)
            expect(() => wrappedHandler(event as CustomEvent)).toThrow(/CustomEvent/);
        });

        it('throws when receiving MouseEvent', () => {
            const handler = vi.fn();
            const wrappedHandler = wrapCustomEventHandler(handler);
            const event = new MouseEvent('click');

            expect(() => wrappedHandler(event as unknown as CustomEvent)).toThrow(/CustomEvent/);
        });

        it('works without handler', () => {
            const wrappedHandler = wrapCustomEventHandler();
            const event = new CustomEvent('test', { detail: {} });

            expect(() => wrappedHandler(event)).not.toThrow();
        });
    });

    describe('wrapPlainEventHandler', () => {
        let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleWarnSpy.mockRestore();
        });

        it('allows plain Event to pass through', () => {
            const handler = vi.fn();
            const wrappedHandler = wrapPlainEventHandler(handler);
            const event = new MouseEvent('click');

            wrappedHandler(event);

            expect(handler).toHaveBeenCalledWith(event);
            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });

        it('warns when receiving CustomEvent', () => {
            const handler = vi.fn();
            const wrappedHandler = wrapPlainEventHandler(handler);
            const event = new CustomEvent('test', { detail: { foo: 'bar' } });

            // Type assertion for test purposes - double cast through unknown
            wrappedHandler(event as unknown as MouseEvent);

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Plain event handler received CustomEvent'),
                expect.any(Object),
            );
        });

        it('works without handler', () => {
            const wrappedHandler = wrapPlainEventHandler();
            const event = new MouseEvent('click');

            expect(() => wrappedHandler(event)).not.toThrow();
        });
    });

    describe('requireValue', () => {
        it('returns value when defined', () => {
            expect(requireValue('test', 'Should exist')).toBe('test');
            expect(requireValue(0, 'Should exist')).toBe(0);
            expect(requireValue(false, 'Should exist')).toBe(false);
        });

        it('throws when value is undefined', () => {
            expect(() => requireValue(undefined, 'Value required')).toThrow(
                'Required value is missing: Value required',
            );
        });

        it('throws when value is null', () => {
            expect(() => requireValue(null, 'Value required')).toThrow(
                'Required value is missing: Value required',
            );
        });

        it('includes context in error message', () => {
            expect(() => requireValue(undefined, 'User name required', { userId: '123' })).toThrow(
                /userId.*123/,
            );
        });
    });

    describe('warnDeprecated', () => {
        let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleWarnSpy.mockRestore();
        });

        it('logs deprecation warning in dev mode', () => {
            warnDeprecated('old pattern', 'new pattern');

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('DEPRECATED: old pattern'),
            );
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('new pattern'));
        });

        it('includes context when provided', () => {
            warnDeprecated('old pattern', 'new pattern', {
                component: 'MediaCard',
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('MediaCard'));
        });
    });

    describe('assertOneOf', () => {
        it('does not throw when value is in valid values', () => {
            expect(() =>
                assertOneOf('movie', ['movie', 'series', 'episode'], 'Invalid media type'),
            ).not.toThrow();
        });

        it('throws when value is not in valid values', () => {
            expect(() =>
                assertOneOf('invalid', ['movie', 'series', 'episode'], 'Invalid media type'),
            ).toThrow('Invalid media type');
        });

        it('includes received and expected values in error', () => {
            expect(() => assertOneOf('invalid', ['movie', 'series'], 'Invalid type')).toThrow(
                /Received.*invalid/,
            );
            expect(() => assertOneOf('invalid', ['movie', 'series'], 'Invalid type')).toThrow(
                /Expected one of/,
            );
        });
    });

    describe('devOnly', () => {
        it('executes function in development mode', () => {
            const fn = vi.fn();

            devOnly(fn);

            // In test environment (dev mode), function should be called
            expect(fn).toHaveBeenCalled();
        });

        it('can perform complex validation', () => {
            const items = [
                { id: '1', name: 'Item 1' },
                { id: '2', name: 'Item 2' },
                { id: '1', name: 'Item 1 Duplicate' },
            ];

            let duplicateFound = false;

            devOnly(() => {
                const seen = new Set();
                for (const item of items) {
                    if (seen.has(item.id)) {
                        duplicateFound = true;
                        break;
                    }
                    seen.add(item.id);
                }
            });

            expect(duplicateFound).toBe(true);
        });
    });

    describe('validateArray', () => {
        let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
        let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            consoleWarnSpy.mockRestore();

            consoleErrorSpy.mockRestore();
        });

        it('does not warn for unique items', () => {
            const items = [
                { id: '1', name: 'Item 1' },
                { id: '2', name: 'Item 2' },
            ];

            validateArray(items, { uniqueKey: 'id' });

            expect(consoleWarnSpy).not.toHaveBeenCalled();
        });

        it('warns when duplicate key found', () => {
            const items = [
                { id: '1', name: 'Item 1' },
                { id: '2', name: 'Item 2' },
                { id: '1', name: 'Item 1 Duplicate' },
            ];

            validateArray(items, {
                uniqueKey: 'id',
                message: 'Duplicate items detected',
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Duplicate items detected'),
                expect.objectContaining({ duplicateValue: '1' }),
            );
        });

        it('validates items with type guard', () => {
            interface TestItem {
                id: string;
                name: string;
            }

            const isTestItem = (val: unknown): val is TestItem => {
                return (
                    typeof val === 'object' &&
                    val !== null &&
                    'id' in val &&
                    'name' in val &&
                    typeof (val as TestItem).id === 'string' &&
                    typeof (val as TestItem).name === 'string'
                );
            };

            const items = [
                { id: '1', name: 'Item 1' },
                { id: 2, name: 'Item 2' }, // Invalid: id is number
            ];

            validateArray(items, {
                typeGuard: isTestItem,
                message: 'Type validation failed',
            });

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Type validation failed'),
                expect.objectContaining({ item: { id: 2, name: 'Item 2' } }),
            );
        });

        it('includes context in warnings', () => {
            const items = [
                { id: '1', name: 'Item 1' },
                { id: '1', name: 'Duplicate' },
            ];

            validateArray(items, {
                uniqueKey: 'id',
                context: { component: 'MediaGrid', itemCount: items.length },
            });

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    component: 'MediaGrid',
                    itemCount: 2,
                }),
            );
        });
    });

    describe('Real-world scenarios', () => {
        it('prevents CustomEvent.detail access on MouseEvent', () => {
            // Simulates: Component expects CustomEvent, receives MouseEvent

            // Component callback that expects CustomEvent<MediaItem>
            const onselect = wrapCustomEventHandler<{
                id: string;
                title: string;
            }>((event) => {
                // Would try to access event.detail
                return event.detail;
            });

            const mouseEvent = new MouseEvent('click');

            // Should throw in development
            expect(() =>
                onselect(
                    mouseEvent as unknown as CustomEvent<{
                        id: string;
                        title: string;
                    }>,
                ),
            ).toThrow(/CustomEvent/);
        });

        it('catches undefined value after optional chaining', () => {
            interface ApiResponse {
                user?: {
                    profile?: {
                        name?: string;
                    };
                };
            }

            const data: ApiResponse = { user: { profile: {} } }; // Missing name

            const processUserName = (response: ApiResponse) => {
                const name = requireValue(
                    response?.user?.profile?.name,
                    'User profile name should exist after authentication',
                    {
                        hasUser: !!response.user,
                        hasProfile: !!response.user?.profile,
                    },
                );

                return name.toUpperCase();
            };

            expect(() => processUserName(data)).toThrow(/User profile name should exist/);
        });

        it('validates callback receives correct parameter type', () => {
            interface MediaItem {
                id: string;
                title: string;
            }

            const isMediaItem = (val: unknown): val is MediaItem => {
                return (
                    typeof val === 'object' &&
                    val !== null &&
                    'id' in val &&
                    'title' in val &&
                    typeof (val as MediaItem).id === 'string' &&
                    typeof (val as MediaItem).title === 'string'
                );
            };

            // Component prop
            let onitemclick: ((item: MediaItem) => void) | undefined = vi.fn();

            // Component function that calls callback
            function handleClick(item: MediaItem) {
                validateCallback(onitemclick, item, isMediaItem, 'onitemclick expects MediaItem');
                onitemclick?.(item);
            }

            const validItem: MediaItem = { id: '1', title: 'Test Movie' };
            const invalidItem = new CustomEvent('click', {
                detail: { id: '1', title: 'Test' },
            });

            // Valid item should work
            expect(() => handleClick(validItem)).not.toThrow();

            // Invalid item should throw
            expect(() => handleClick(invalidItem as unknown as MediaItem)).toThrow(
                /onitemclick expects MediaItem/,
            );
        });
    });
});
