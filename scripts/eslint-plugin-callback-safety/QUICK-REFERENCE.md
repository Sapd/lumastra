# Callback Safety - Quick Reference

## Run Linting

```bash
npm run lint
```

## Common Fixes

### ❌ CustomEvent in Callback Prop → ✅ Plain Type

```typescript
// ❌ Before
export let onclick: (event: CustomEvent<MediaItem>) => void;

// ✅ After
export let onclick: (item: MediaItem) => void;
```

### ❌ Optional Chain in Fetch → ✅ requireValue

```typescript
// ❌ Before
const id = item?.tmdbId;
fetch(`/api/data/${id}`);

// ✅ After
import { requireValue } from '$lib/utils/runtime-validation';
const id = requireValue(item?.tmdbId, 'Item must have tmdbId');
fetch(`/api/data/${id}`);
```

### ❌ No Validation → ✅ Add validateCallback

```typescript
// ❌ Before
export let onclick: (item: MediaItem) => void;
function handleClick(item: MediaItem) {
    onclick(item);
}

// ✅ After
import { validateCallback } from '$lib/utils/runtime-validation';
export let onclick: (item: MediaItem) => void;
function handleClick(item: MediaItem) {
    validateCallback(onclick, item, isMediaItem, 'onclick expects MediaItem');
    onclick(item);
}
```

## Import Statements

```typescript
import {
    requireValue,
    validateCallback,
    wrapCustomEventHandler,
    assertDefined,
    assertType,
} from '$lib/utils/runtime-validation';
```

## Disable Rules

```typescript
// Single line
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop
export let onclick: (event: CustomEvent<T>) => void;

// With reason
// eslint-disable-next-line callback-safety/no-custom-event-in-callback-prop -- Library API requirement
export let onLibraryEvent: (event: CustomEvent<Data>) => void;

// Entire file
/* eslint-disable callback-safety/validate-callback-parameters */
```

## Rule Names

1. `callback-safety/no-custom-event-in-callback-prop`
2. `callback-safety/require-validation-optional-chaining`
3. `callback-safety/validate-callback-parameters`

## Documentation

- **Usage Guide:** `scripts/eslint-plugin-callback-safety/USAGE.md`
- **Full Patterns:** `docs/dev/lint-rules/callback-types.md`
- **Runtime Utils:** `src/lib/utils/runtime-validation.ts`
- **Project Guide:** `CLAUDE.md` (Section: Custom Callback Safety Rules)
