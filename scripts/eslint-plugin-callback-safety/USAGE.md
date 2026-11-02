# Callback Safety ESLint Plugin - Usage Guide

## Quick Start

The custom ESLint plugin is already integrated into the project. Run linting as usual:

```bash
npm run lint
```

The plugin will automatically detect callback type mismatches in your Svelte components.

## What It Catches

### 1. CustomEvent Type Mismatches

**Problem:** Component prop typed as `CustomEvent<T>` but component passes plain values.

```typescript
// ❌ BAD - Will trigger warning
export let onclick: (event: CustomEvent<MediaItem>) => void;

function handleClick(item: MediaItem) {
    onclick?.(item); // Passing MediaItem, not CustomEvent!
}
```

**Fix Options:**

```typescript
// ✅ Option 1: Use plain type
export let onclick: (item: MediaItem) => void;

// ✅ Option 2: Use native event type
export let onclick: (event: MouseEvent) => void;

// ✅ Option 3: Use validation wrapper
import { wrapCustomEventHandler } from '$lib/utils/runtime-validation';
export let onclick = wrapCustomEventHandler<MediaItem>();
```

### 2. Optional Chaining in Critical Contexts

**Problem:** Using optional chaining (`?.`) in fetch URLs, API calls where `undefined` becomes `"undefined"` string.

```typescript
// ❌ BAD - Will trigger warning
const id = item?.tmdbId;
fetch(`/api/data/${id}`); // If tmdbId is undefined, URL is "/api/data/undefined"
```

**Fix Options:**

```typescript
// ✅ Option 1: Use requireValue helper
import { requireValue } from '$lib/utils/runtime-validation';
const id = requireValue(item?.tmdbId, 'Item must have tmdbId', {
    itemId: item?.id,
});
fetch(`/api/data/${id}`);

// ✅ Option 2: Explicit null check
if (!item?.tmdbId) {
    throw new Error('Item must have tmdbId for this operation');
}
fetch(`/api/data/${item.tmdbId}`);

// ✅ Option 3: Early return
if (!item?.tmdbId) return null;
fetch(`/api/data/${item.tmdbId}`);
```

### 3. Callback Invocations Without Validation

**Problem:** Calling callback props without runtime validation to catch type mismatches in development.

```typescript
// ⚠️ Suggestion - Will trigger warning
export let onclick: (item: MediaItem) => void;

function handleClick(item: MediaItem) {
    onclick(item); // No validation
}
```

**Fix:**

```typescript
// ✅ Add validation
import { validateCallback } from '$lib/utils/runtime-validation';

function handleClick(item: MediaItem) {
    validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
    onclick(item);
}
```

**Note:** This validation only runs in development mode and is tree-shaken in production.

## Runtime Validation Helpers

Import from `$lib/utils/runtime-validation`:

### requireValue()

Ensures a value is not null/undefined. Throws in dev, logs in production.

```typescript
import { requireValue } from '$lib/utils/runtime-validation';

const id = requireValue(item?.tmdbId, 'Item must have tmdbId for recommendations', {
    itemId: item?.id,
    itemType: item?.mediaType,
});
```

### validateCallback()

Validates callback parameters match expected type in development.

```typescript
import { validateCallback } from '$lib/utils/runtime-validation';

export let onselect: (item: MediaItem) => void;

function handleSelect(item: MediaItem) {
    validateCallback(onselect, item, isMediaItem, 'onselect expects MediaItem');
    onselect(item);
}
```

### wrapCustomEventHandler()

Creates a validated CustomEvent handler.

```typescript
import { wrapCustomEventHandler } from '$lib/utils/runtime-validation';

export let ondata = wrapCustomEventHandler<DataPayload>();

// Component internals
function dispatchData(data: DataPayload) {
    const event = new CustomEvent('data', { detail: data });
    ondata(event); // Validates event type in dev
}
```

### Type Guards

Use with validation functions:

```typescript
import { isMediaItem, isRecord, isString } from '$lib/utils/data-extraction';

// In validateCallback calls
validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
```

## Disabling Rules

### Disable for a Specific Line

```typescript
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop
export let onclick: (event: CustomEvent<MediaItem>) => void;
```

### Disable with Justification

```typescript
// This callback comes from a third-party library that requires CustomEvent
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop -- Library API requirement
export let onLibraryEvent: (event: CustomEvent<LibraryData>) => void;
```

### Disable for Entire File

```svelte
<script lang="ts">
    /* eslint-disable callback-safety/validate-callback-parameters */

    // File contents...
</script>
```

### Disable Specific Rule for Block

```typescript
/* eslint-disable callback-safety/require-validation-optional-chaining */
const id = item?.tmdbId; // Won't warn
fetch(`/api/data/${id}`);
/* eslint-enable callback-safety/require-validation-optional-chaining */
```

## Configuration

Rules are configured in `eslint.config.cjs`:

```javascript
{
  files: ['**/*.svelte'],
  plugins: {
    'callback-safety': callbackSafety
  },
  rules: {
    'callback-safety/no-custom-event-in-callback-prop': 'warn',
    'callback-safety/require-validation-optional-chaining': 'warn',
    'callback-safety/validate-callback-parameters': 'warn'
  }
}
```

### Rule Options

**no-custom-event-in-callback-prop:**

```javascript
'callback-safety/no-custom-event-in-callback-prop': ['warn', {
  allowWithValidation: true // Allow if wrapCustomEventHandler() is used
}]
```

**require-validation-optional-chaining:**

```javascript
'callback-safety/require-validation-optional-chaining': ['warn', {
  criticalContexts: ['fetch', 'Request', 'URL'], // Functions to check
  suggestHelper: 'requireValue' // Helper to suggest in messages
}]
```

**validate-callback-parameters:**

```javascript
'callback-safety/validate-callback-parameters': ['warn', {
  requireValidation: true,   // Require validation for all callbacks
  exemptBuiltIns: true       // Don't require for addEventListener, etc.
}]
```

## Common Patterns

### Event Handlers from DOM Events

```typescript
// ✅ Correct: Use native event type
export let onclick: (event: MouseEvent) => void;
export let onkeypress: (event: KeyboardEvent) => void;
```

### Custom Data Callbacks

```typescript
// ✅ Correct: Use plain data type
export let onselect: (item: MediaItem) => void;
export let onchange: (value: string) => void;
export let ondata: (data: SearchResults) => void;
```

### Svelte Component Events (createEventDispatcher)

```typescript
import { createEventDispatcher } from 'svelte';

interface Events {
    select: MediaItem; // detail type
    delete: { id: string };
}

const dispatch = createEventDispatcher<Events>();

// ✅ Dispatching creates CustomEvent automatically
function handleSelect(item: MediaItem) {
    dispatch('select', item);
}

// ✅ Parent handles typed CustomEvent
// <Component on:select={(e) => console.log(e.detail.title)} />
```

### Optional Values in Safe Contexts

```typescript
// ✅ OK: Optional chaining not in critical context
const title = item?.title || 'Unknown';
console.log(`Title: ${title}`);

// ✅ OK: Template with fallback
const display = `${item?.title ?? 'No title'}`;

// ⚠️ WARNING: Optional chaining in fetch URL
fetch(`/api/item/${item?.id}`); // Triggers rule
```

## Testing

Run plugin tests:

```bash
npm run lint:callback-safety
```

Or manually:

```bash
node scripts/eslint-plugin-callback-safety/tests/run-tests.js
```

## Real Bugs Prevented

This plugin was created after finding these actual bugs:

1. **Search.svelte** - `onclick` typed as `CustomEvent<MediaItem>` but received plain `MediaItem`, causing `event.detail` to be `undefined`
2. **ModalBody.svelte** - Optional chaining in fetch URLs causing `"undefined"` string in API calls
3. **MediaCard.svelte** - Callback type mismatches causing silent failures in parent components

## Performance

- Rules only run during linting (not at runtime)
- No performance impact on application
- Validation helpers are development-only (tree-shaken in production)

## IDE Integration

Most IDEs with ESLint integration will show warnings inline:

- **VS Code:** Install ESLint extension, warnings appear as you type
- **WebStorm/IntelliJ:** ESLint integration built-in
- **Vim/Neovim:** Use ALE or similar ESLint plugin

## Further Reading

- `README.md` - Plugin architecture and rule descriptions
- `docs/dev/lint-rules/callback-types.md` - Detailed patterns and antipatterns
- `src/lib/utils/runtime-validation.ts` - Runtime validation utilities API
- `CLAUDE.md` - Project coding guidelines

## Support

For questions or issues:

1. Check existing usage in the codebase
2. Review `docs/dev/lint-rules/callback-types.md`
3. Disable rule with clear justification comment
