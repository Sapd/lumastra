# ESLint Plugin: Callback Safety

Custom ESLint plugin to detect callback type mismatches that cause silent runtime failures in Svelte components.

## Problem

TypeScript can't catch certain callback type mismatches at compile time, especially in Svelte components:

```typescript
// ❌ Compiles but fails at runtime
export let onclick: (event: CustomEvent<MediaItem>) => void;

function handleClick(item: MediaItem) {
  onclick?.(item); // Passing MediaItem, not CustomEvent!
}

// Parent component
<MediaCard
  onclick={(event) => {
    console.log(event.detail.title); // event.detail is undefined!
  }}
/>
```

## Rules

### 1. `no-custom-event-in-callback-prop` (warn)

Detects when a component prop is typed as `CustomEvent<T>` but likely receives plain values.

**Detects:**

```typescript
export let onclick: (event: CustomEvent<MediaItem>) => void;
export let onselect?: (e: CustomEvent<Data>) => void;
```

**Suggests:**

```typescript
// Fix 1: Use plain data type
export let onclick: (item: MediaItem) => void;

// Fix 2: Use native event type
export let onclick: (event: MouseEvent) => void;

// Fix 3: Add validation wrapper
export let onclick = wrapCustomEventHandler<MediaItem>();
```

### 2. `require-validation-optional-chaining` (warn)

Detects optional chaining in critical contexts where `undefined` causes silent failures.

**Detects:**

```typescript
const id = item?.tmdbId;
fetch(`/api/data/${id}`); // id = "undefined" in URL!

const userId = data?.user?.id;
new URL(`/profile/${userId}`); // Broken URL
```

**Suggests:**

```typescript
// Fix 1: Use requireValue()
const id = requireValue(item?.tmdbId, 'Item must have tmdbId');
fetch(`/api/data/${id}`);

// Fix 2: Explicit null check
if (!item?.tmdbId) throw new Error('Item must have tmdbId');
fetch(`/api/data/${item.tmdbId}`);
```

### 3. `validate-callback-parameters` (warn)

Suggests validation when invoking callback props with complex types.

**Detects:**

```typescript
export let onclick: (item: MediaItem) => void;

function handleClick(item: MediaItem) {
    onclick(item); // No validation
}
```

**Suggests:**

```typescript
import { validateCallback } from '$lib/utils/runtime-validation';

function handleClick(item: MediaItem) {
    validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
    onclick(item);
}
```

## Installation

The plugin is already installed locally in this project.

### Enable in ESLint Config

Edit `eslint.config.cjs`:

```javascript
const callbackSafety = require('./scripts/eslint-plugin-callback-safety');

module.exports = [
    // ... existing config
    {
        files: ['**/*.svelte'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-custom-event-in-callback-prop': 'warn',
            'callback-safety/require-validation-optional-chaining': 'warn',
            'callback-safety/validate-callback-parameters': 'warn',
        },
    },
];
```

Or use the recommended config:

```javascript
{
  files: ['**/*.svelte'],
  plugins: {
    'callback-safety': callbackSafety
  },
  ...callbackSafety.configs.recommended.rules
}
```

## Configuration

### Rule 1: no-custom-event-in-callback-prop

```javascript
'callback-safety/no-custom-event-in-callback-prop': ['warn', {
  allowWithValidation: true  // Allow if wrapCustomEventHandler() is used
}]
```

### Rule 2: require-validation-optional-chaining

```javascript
'callback-safety/require-validation-optional-chaining': ['warn', {
  criticalContexts: ['fetch', 'Request', 'URL', 'new URL'],  // Functions to check
  suggestHelper: 'requireValue'  // Helper function to suggest
}]
```

### Rule 3: validate-callback-parameters

```javascript
'callback-safety/validate-callback-parameters': ['warn', {
  requireValidation: true,   // Require validation for all callback props
  exemptBuiltIns: true      // Don't require for addEventListener, etc.
}]
```

## Usage

Run ESLint:

```bash
npm run lint
```

Auto-fix what's possible:

```bash
npm run lint -- --fix
```

## Disabling Rules

For specific lines:

```typescript
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop
export let onclick: (event: CustomEvent<MediaItem>) => void;
```

For entire files:

```typescript
/* eslint-disable callback-safety/validate-callback-parameters */
```

For specific cases with justification:

```typescript
// This callback comes from a library that guarantees CustomEvent
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop -- Library API requires CustomEvent
export let onLibraryEvent: (event: CustomEvent<LibraryData>) => void;
```

## Runtime Validation Helpers

These utilities work with the ESLint rules to provide runtime safety:

```typescript
import {
    validateCallback,
    requireValue,
    wrapCustomEventHandler,
    assertDefined,
    assertType,
} from '$lib/utils/runtime-validation';

// Validate callback parameters
validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');

// Require non-undefined values
const id = requireValue(item?.tmdbId, 'Item must have tmdbId');

// Wrap CustomEvent handlers
export let onselect = wrapCustomEventHandler<MediaItem>();

// Assert values in dev mode
assertDefined(user, 'User must be defined');
assertType(event, isMouseEvent, 'Event must be MouseEvent');
```

**Note:** These helpers are development-only and tree-shaken in production builds.

## Testing

Run tests for the ESLint rules:

```bash
npm test -- scripts/eslint-plugin-callback-safety/tests
```

## Related Documentation

- `docs/dev/lint-rules/callback-types.md` - Detailed patterns and examples
- `src/lib/utils/runtime-validation.ts` - Runtime validation utilities
- `CLAUDE.md` - Project coding guidelines

## Why These Rules?

**Real bugs caught:**

1. **Search.svelte** - `onclick` typed as `CustomEvent<MediaItem>` but received `MediaItem`, causing `event.detail` to be undefined
2. **ModalBody.svelte** - Optional chaining in fetch URLs causing "undefined" in API calls
3. **MediaCard.svelte** - Callback type mismatch causing silent failures in parent components

These rules prevent TypeScript's type system from giving false confidence when callback signatures don't match runtime behavior.
