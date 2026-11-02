# Server Configuration System

## Configuration Loading

Three-tier precedence:

1. **Default values** (hardcoded in config.ts)
2. **JSON file** (ConfigService at config/settings.json, loaded at startup)
3. **ENV variables** (highest priority)

The `config` object is imported directly in 200+ files. Property names are the public API surface.

## Features Object

Feature flags use getter accessors that combine FEATURE\_\* env flags with service availability checks:

```typescript
get requests(): boolean {
    return config.FEATURE_REQUEST_MODAL &&
           !!config.SEERRURL &&
           !!config.SEERRAPIKEY;
}
```

Frontend receives auto-generated features from `Object.keys(features)` filtered through `BACKEND_ONLY_FEATURES` exclusion set.

## Permission System

User permissions computed from group membership via `buildUserPermissions(userGroups)`:

- **hasWatchPermission** - can see all users' streaming sessions
- **hasLiveTvPermission** - can access live TV
- **hasRequestPermission** - can request new content (granted to all when REQUEST_GROUPS is empty)
- **hasReviewPermission** - can create/edit community reviews (granted to all when SOCIAL_REVIEW_GROUPS is empty)
- **hasMediaAnnotationPermission** - can view/create player community pins/chat (granted to all when MEDIA_ANNOTATION_GROUPS is empty)
- **isAdmin** - admin privileges
- **maxAgeRating** - maximum content age rating (null = unrestricted, from age-{N} IdP groups)
- **isAgeRestricted** - whether user has any age restriction (maxAgeRating !== null)

All group comparisons are case-insensitive and trim whitespace.

## Plugin Configuration

Plugin settings loaded from three sources (same precedence as main config):

1. **Manifest defaults** (from configSchema)
2. **JSON file** (config/plugins.json)
3. **ENV variables** (PLUGIN*&lt;ID&gt;*&lt;KEY&gt;=value)

Schema-aware boolean parsing: when plugin schema declares `type=boolean`, environment values "1"/"0" are treated as boolean (not integer).
