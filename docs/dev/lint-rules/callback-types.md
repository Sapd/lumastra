# ESLint Patterns for Callback Type Safety

This document describes patterns to detect callback type mismatches that cause silent failures.

## Problem Patterns

### Pattern 1: CustomEvent in Plain Callback Props

**Anti-pattern:** Callback prop typed with CustomEvent when component calls it with plain values.

```typescript
// ❌ BAD: Component definition
interface Props {
  onclick?: (event: CustomEvent<MediaItem>) => void;
}
export let onclick: Props['onclick'] = undefined;

// Component calls onclick with MediaItem (not CustomEvent!)
function handleClick(item: MediaItem) {
  onclick?.(item); // Type error hidden at runtime
}

// ❌ Parent usage (compiles but fails at runtime)
<MediaCard
  onclick={(event) => {
    console.log(event.detail.title); // event is MediaItem, not CustomEvent!
    // event.detail is undefined → silent failure
  }}
/>
```

**Fix:** Use plain callback or validate at runtime.

```typescript
// ✅ GOOD: Clear callback signature
interface Props {
  onclick?: (item: MediaItem) => void;
}
export let onclick: Props['onclick'] = undefined;

function handleClick(item: MediaItem) {
  validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
  onclick?.(item);
}

// ✅ Parent usage (clear intent)
<MediaCard
  onclick={(item) => {
    console.log(item.title); // Clear: item is MediaItem
  }}
/>
```

### Pattern 2: Mixed Event Types in Callback Chains

**Anti-pattern:** Event handlers that sometimes receive CustomEvent, sometimes plain Event.

```typescript
// ❌ BAD: Ambiguous event type
export let onaction: (event: Event) => void = () => {};

function handleKeyPress(event: KeyboardEvent) {
    onaction(event); // Sometimes KeyboardEvent
}

function handleCustomAction(data: ActionData) {
    const customEvent = new CustomEvent('action', { detail: data });
    onaction(customEvent); // Sometimes CustomEvent
}
```

**Fix:** Separate callbacks for different event types.

```typescript
// ✅ GOOD: Separate callbacks
export let onkeypress: (event: KeyboardEvent) => void = () => {};
export let onaction: (data: ActionData) => void = () => {};

function handleKeyPress(event: KeyboardEvent) {
    onkeypress(event);
}

function handleCustomAction(data: ActionData) {
    validateCallback(onaction, data, isActionData, 'onaction expects ActionData');
    onaction(data);
}
```

### Pattern 3: Optional Chaining Without Validation

**Anti-pattern:** Using optional chaining on values that should never be undefined.

```typescript
// ❌ BAD: Silent undefined propagation
async function fetchRecommendations(item?: MediaItem) {
    const tmdbId = item?.tmdbId; // Could be undefined
    const url = `/api/recommendations/${tmdbId}`; // "undefined" in URL!

    return fetch(url); // 404 or invalid request
}
```

**Fix:** Explicit validation when value should exist.

```typescript
// ✅ GOOD: Explicit validation
async function fetchRecommendations(item?: MediaItem) {
    const tmdbId = requireValue(item?.tmdbId, 'MediaItem must have tmdbId for recommendations', {
        itemId: item?.id,
    });

    const url = `/api/recommendations/${tmdbId}`;
    return fetch(url);
}
```

## Manual Review Checklist

Until automated ESLint rules exist, use this checklist during code review:

### 1. Component Props with Callbacks

**Check for:**

```typescript
// 🔍 Review this pattern
export let onclick: (event: CustomEvent<T>) => void;
export let onselect: (event: Event) => void;
```

**Questions to ask:**

- Does the component actually dispatch a CustomEvent?
- Or does it call the callback with a plain value?
- Is the event type intentional or a copy-paste error?

**Example review comment:**

```
⚠️  This onclick prop expects CustomEvent, but handleClick calls it with
a plain MouseEvent. This will cause event.detail to be undefined.

Consider either:
1. Change prop to: onclick?: (event: MouseEvent) => void
2. Dispatch CustomEvent: onclick?.(new CustomEvent('click', { detail: item }))
3. Pass plain value: onclick?: (item: MediaItem) => void
```

### 2. Event Handler Implementations

**Check for:**

```typescript
// 🔍 Review this pattern
function handleClick(event: MouseEvent) {
    onclick?.(event); // What type does onclick expect?
}

function handleSelect(item: MediaItem) {
    onselect?.(item); // Does onselect expect MediaItem or CustomEvent?
}
```

**Questions to ask:**

- Does the prop type match what's being passed?
- Is there runtime validation?
- Could this fail silently?

### 3. Optional Chaining Chains

**Check for:**

```typescript
// 🔍 Review this pattern
const value = data?.user?.profile?.name;
doSomething(value); // Is undefined valid here?

const id = item?.tmdbId;
fetch(`/api/data/${id}`); // Could id be undefined?
```

**Questions to ask:**

- Should this value always exist at this point?
- Is undefined a valid state, or a bug?
- Should we fail fast with requireValue()?

**Example review comment:**

```
⚠️  This optional chaining could mask a bug. If item.tmdbId is undefined,
the fetch will fail with a confusing 404 error.

Consider using requireValue() if tmdbId should always exist:
const id = requireValue(item?.tmdbId, 'Item must have tmdbId', { itemId: item?.id });
```

### 4. Array Props Without Validation

**Check for:**

```typescript
// 🔍 Review this pattern
export let items: MediaItem[] = [];

{#each items as item (item.id)}
  <MediaCard {item} />
{/each}
```

**Questions to ask:**

- Could items contain duplicates?
- Are all items guaranteed to be valid MediaItem?
- Should we validate in development?

**Example review comment:**

```
⚠️  This component could receive duplicate items, causing Svelte key conflicts.
Consider adding development validation:

$: validateArray(items, {
  uniqueKey: 'id',
  message: 'MediaGrid received duplicate items'
});
```

## Potential ESLint Rules

Future automated rules to implement:

### Rule 1: `no-custom-event-in-callback-prop`

**Detects:**

```typescript
// ❌ Triggers rule
export let onclick: (event: CustomEvent<T>) => void;
```

**Suggests:**

```typescript
// ✅ Fix 1: Use plain event
export let onclick: (event: MouseEvent) => void;

// ✅ Fix 2: Pass data directly
export let onclick: (item: MediaItem) => void;

// ✅ Fix 3: Add validation
export let onclick = wrapCustomEventHandler<MediaItem>();
```

**Rule configuration:**

```javascript
{
  'svelte/no-custom-event-in-callback-prop': ['warn', {
    allowWithValidation: true // OK if wrapCustomEventHandler used
  }]
}
```

### Rule 2: `require-validation-for-critical-optional-chaining`

**Detects:**

```typescript
// ❌ Triggers rule (in fetch, API calls, etc.)
const id = item?.tmdbId;
fetch(`/api/data/${id}`);
```

**Suggests:**

```typescript
// ✅ Fix 1: Use requireValue
const id = requireValue(item?.tmdbId, 'Item must have tmdbId');
fetch(`/api/data/${id}`);

// ✅ Fix 2: Explicit null check
if (!item?.tmdbId) throw new Error('Item must have tmdbId');
fetch(`/api/data/${item.tmdbId}`);
```

**Rule configuration:**

```javascript
{
  'require-validation-for-critical-optional-chaining': ['warn', {
    criticalContexts: ['fetch', 'Request', 'URL'],
    suggestHelper: 'requireValue'
  }]
}
```

### Rule 3: `validate-callback-parameters`

**Detects:**

```typescript
// ❌ Triggers rule
export let onclick: (item: MediaItem) => void;

function handleClick(item: MediaItem) {
    onclick(item); // No validation
}
```

**Suggests:**

```typescript
// ✅ Fix: Add validation
import { validateCallback } from '$lib/utils/runtime-validation';

function handleClick(item: MediaItem) {
    validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
    onclick(item);
}
```

**Rule configuration:**

```javascript
{
  'validate-callback-parameters': ['warn', {
    requireValidation: true,
    exemptBuiltIns: true // Don't require for addEventListener, etc.
  }]
}
```

## Implementation Strategy

### Phase 1: Manual Review (Current)

1. Use this document during code review
2. Add validation to high-risk areas manually
3. Document patterns in component docs

### Phase 2: Custom ESLint Plugin

Create `eslint-plugin-svelte-callback-safety`:

```javascript
// eslint-plugin-svelte-callback-safety/index.js
module.exports = {
    rules: {
        'no-custom-event-in-callback-prop': require('./rules/no-custom-event-in-callback-prop'),
        'require-validation-for-critical-optional-chaining': require('./rules/require-validation'),
        'validate-callback-parameters': require('./rules/validate-callback-parameters'),
    },
    configs: {
        recommended: {
            plugins: ['svelte-callback-safety'],
            rules: {
                'svelte-callback-safety/no-custom-event-in-callback-prop': 'warn',
                'svelte-callback-safety/require-validation-for-critical-optional-chaining': 'warn',
                'svelte-callback-safety/validate-callback-parameters': 'warn',
            },
        },
    },
};
```

### Phase 3: IDE Integration

Add quick fixes to ESLint rules:

```typescript
// In ESLint rule implementation
context.report({
    node,
    message: 'Callback prop should not use CustomEvent type',
    fix(fixer) {
        return fixer.replaceText(node, 'export let onclick: (item: MediaItem) => void;');
    },
});
```

## Testing ESLint Rules

```typescript
// scripts/eslint-plugin-callback-safety/tests/no-custom-event-in-callback-prop.test.js
import { RuleTester } from 'eslint';
import rule from '../rules/no-custom-event-in-callback-prop';

const ruleTester = new RuleTester({
    parser: require.resolve('svelte-eslint-parser'),
});

ruleTester.run('no-custom-event-in-callback-prop', rule, {
    valid: [
        {
            code: 'export let onclick: (event: MouseEvent) => void;',
            filename: 'Component.svelte',
        },
        {
            code: 'export let onselect: (item: MediaItem) => void;',
            filename: 'Component.svelte',
        },
    ],
    invalid: [
        {
            code: 'export let onclick: (event: CustomEvent<MediaItem>) => void;',
            filename: 'Component.svelte',
            errors: [
                {
                    message: 'Callback prop should not use CustomEvent type',
                    type: 'Property',
                },
            ],
        },
    ],
});
```

## Related Patterns

### Pattern: Type-Safe Event Dispatchers

Instead of relying on correct callback types, use type-safe event dispatchers:

```typescript
import { createEventDispatcher } from 'svelte';

interface Events {
  select: MediaItem;
  delete: { id: string };
}

const dispatch = createEventDispatcher<Events>();

function handleSelect(item: MediaItem) {
  dispatch('select', item); // Type-safe dispatch
}

// Parent
<MediaCard
  on:select={(event) => {
    // event.detail is automatically MediaItem
    console.log(event.detail.title);
  }}
/>
```

### Pattern: Typed Callbacks with Builders

```typescript
import type { MediaItem } from '$lib/types';

// Type-safe callback builder
export function createMediaItemCallback(
    handler: (item: MediaItem) => void,
): (item: MediaItem) => void {
    return (item: MediaItem) => {
        validateCallback(handler, item, isMediaItem, 'Handler expects MediaItem');
        handler(item);
    };
}

// Usage
export let onselect = createMediaItemCallback((item) => {
    console.log(item.title); // Guaranteed MediaItem
});
```

## Summary

**Until automated ESLint rules exist:**

1. ✅ Use manual review checklist during PR reviews
2. ✅ Add runtime validation to high-risk components
3. ✅ Document callback types clearly in component interfaces
4. ✅ Test components with different callback signatures
5. ✅ Use type guards to validate parameters

**Future improvements:**

1. ⏳ Implement custom ESLint plugin for automated detection
2. ⏳ Add IDE quick fixes for common patterns
3. ⏳ Integrate with CI/CD to fail on callback type mismatches
4. ⏳ Generate runtime validation code automatically

**Key takeaway:** Callback type safety is a **runtime concern**, not just a compile-time one. TypeScript can't catch these bugs alone - we need runtime validation and code review patterns.
