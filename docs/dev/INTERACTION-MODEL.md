# Media Card Interaction Model

## Philosophy

**Overlay = Intent. Buttons = Choice. No invisible rules.**

The interaction model follows a simple, discoverable pattern:

- Cards are for exploration (click → modal)
- Overlays show explicit action buttons
- Every interactive element is visible and labeled

## Two-State Model

### 1. Card (No Overlay)

**Behavior:**

- Hover → Shows overlay after 400ms delay
- Click anywhere → Opens media details modal
- No spatial logic, no hidden zones

**Purpose:** Quick exploration and discovery

**Implementation:**

```svelte
<UniversalMediaCard {item} on:click={handleClick} />

function handleClick() {
    openMediaModal(item);
}
```

### 2. Overlay (Visible)

**Behavior:**

- Explicit buttons for all actions
- Primary action: Play/Continue (blue button)
- Secondary actions: Info, More, Request (ghost buttons)

**Purpose:** Informed decision-making with full context

**Buttons:**

| Button        | Icon | Action                      | Style          |
| ------------- | ---- | --------------------------- | -------------- |
| Play/Continue | ▶    | Watch content               | Primary (blue) |
| Info          | ⓘ    | Open details modal          | Ghost          |
| More          | ✨   | Similar content             | Ghost          |
| Request       | +    | Request unavailable content | Secondary      |

## Event Flow

```
User hovers card
  → MediaHoverCard shows overlay (400ms delay)
    → User clicks button
      → dispatch(action)
        → SectionRenderer bubbles event
          → Page component handles action
```

## Why This Model Works

### 1. Discoverable

New users understand immediately:

- "Click card = see details"
- "Buttons do what they say"

### 2. Explicit

No guessing:

- Every action has a visible button
- Buttons have labels and icons
- Tooltips provide additional context

### 3. Scalable

Works everywhere:

- Any screen size (mobile, tablet, desktop)
- Any content type (movies, series, episodes)
- Any context (For You, Browse, Search)

### 4. Accessible

ARIA labels, keyboard navigation, focus indicators all work naturally with explicit buttons.

### 5. Maintainable

Simple rules:

- Card dispatches 'click' → modal
- Buttons dispatch actions → handlers
- No complex spatial logic to debug

## Anti-Patterns (Avoided)

❌ **Invisible click zones** - Users can't see them
❌ **Spatial logic** (center vs edges) - Arbitrary and confusing
❌ **Dual-purpose areas** - Ambiguous interactions
❌ **Context-dependent clicks** - "Click here means X unless Y"

## Mobile Behavior

On touch devices:

- Hover overlay is disabled (no hover on mobile)
- Card click opens modal directly
- All interactions happen on the card itself
- Progressive enhancement: touch users get simpler, faster experience

## Implementation Details

### MediaHoverCard

**Renders:**

- Backdrop image or video preview
- Metadata (title, rating, genres, overview)
- Action buttons (play, info, more, request)
- Progressive disclosure (watch state badge after 1s hover)

**Does NOT:**

- Have invisible click zones
- Intercept card clicks
- Apply spatial interaction logic

### UniversalMediaCard

**Handles:**

- Card rendering (poster, list, backdrop variants)
- Click events → dispatches 'click' event
- Button actions → dispatches specific events

**Does NOT:**

- Know about modals (that's the parent's job)
- Handle hover state (that's MediaHoverCard's job)
- Apply business logic (that's the service layer)

## Future Considerations

### Trailer Overlay (Optional)

If we want to add trailer functionality:

```svelte
<!-- In MediaHoverCard overlay buttons -->
<button class="action-btn ghost" data-action="trailer">
    <svg><!-- play icon --></svg>
    <span>Trailer</span>
</button>
```

**Why this works:**

- Still explicit (visible button)
- Still labeled (text + icon)
- Still discoverable (appears in overlay)
- Doesn't break the model

### Quick Actions (Optional)

For power users who want faster interactions:

**Keyboard shortcuts:**

- `Space` on focused card → Play
- `Enter` on focused card → Modal
- `T` on focused card → Trailer

**Why this works:**

- Opt-in (must focus card first)
- Explicit (documented shortcuts)
- Doesn't change the base model

## Testing Checklist

**Card Behavior:**

- [ ] Click card (no overlay) → Opens modal
- [ ] Hover card → Shows overlay (400ms)
- [ ] Move away from card → Hides overlay (150ms forgiveness)

**Overlay Buttons:**

- [ ] Click Play → Plays content
- [ ] Click Info → Opens modal (same as card click)
- [ ] Click More → Opens similar content
- [ ] Click Request → Opens request modal
- [ ] All buttons have proper hover states
- [ ] All buttons have aria-labels
- [ ] Keyboard navigation works (Tab, Enter)

**Mobile:**

- [ ] No overlay on touch devices
- [ ] Card click opens modal directly
- [ ] No hover delays or forgiveness zones

## Success Metrics

**User comprehension:**

- Users understand what each button does without explanation
- No confusion about how to play content
- No confusion about how to explore content

**Interaction efficiency:**

- Fast path to play (click overlay Play button)
- Fast path to explore (click card)
- No dead clicks or unexpected behaviors

**Code maintainability:**

- Simple event flow
- Easy to debug
- Easy to extend with new actions

## Summary

This interaction model prioritizes **clarity over cleverness**. Every interaction is:

- Visible
- Labeled
- Explicit
- Discoverable

No invisible rules. No spatial logic. Just buttons that do what they say.
