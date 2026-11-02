# Holiday Recommendations Plugin

A configurable plugin for displaying seasonal/holiday-themed content recommendations. Supports multiple content sources (TMDB, MDBList, custom IDs) with AI personalization.

## Configuration

### File Location

The configuration file is located at:

- **Development:** `static/config/holidays.json`
- **Production:** Bundled with the app in `static/config/holidays.json`
- **Custom path:** Set `HOLIDAY_CONFIG_PATH` environment variable

The file includes a JSON schema reference for IDE autocompletion:

```json
{
  "$schema": "./holidays.schema.json",
  ...
}
```

### Hot Reload

- **Development:** Config changes are automatically detected every 10 seconds
- **Production:** Restart the server or call `reloadConfig()` programmatically

## Plugin Settings

The holiday plugin is configured through the plugin settings system in Admin > Settings > Plugins.

Settings available:

- **Enable/Disable** - Toggle the plugin on/off
- **Default Limit** - Maximum recommendations per holiday (default: 20)
- **AI Personalization** - Use AI for personalized recommendations (default: true)
- **Cache TTL** - Cache duration for recommendations in minutes (default: 30)

## Configuration Structure

### Settings

```json
{
    "settings": {
        "enabled": true,
        "defaultLimit": 20,
        "enableAiPersonalization": true,
        "cacheTtlMinutes": 30,
        "jellyfinCacheTtlHours": 6
    }
}
```

| Field                     | Type    | Default | Description                                                           |
| ------------------------- | ------- | ------- | --------------------------------------------------------------------- |
| `enabled`                 | boolean | `true`  | Master switch for the plugin                                          |
| `defaultLimit`            | number  | `20`    | Default number of recommendations                                     |
| `enableAiPersonalization` | boolean | `true`  | Use AI to personalize results                                         |
| `cacheTtlMinutes`         | number  | `30`    | How long to cache recommendations                                     |
| `jellyfinCacheTtlHours`   | number  | `6`     | Unused (availability is resolved per request); kept for compatibility |

### Holiday Configuration

```json
{
  "holidays": [
    {
      "id": "christmas",
      "name": "Christmas",
      "localizedNames": { "de": "Weihnachten", "fr": "Noël" },
      "emoji": "🎄",
      "startMonth": 11,
      "startDay": 20,
      "endMonth": 12,
      "endDay": 27,
      "sources": [...],
      "backgroundColor": "#165B33",
      "textColor": "#FFFFFF",
      "priority": 10,
      "enabled": true
    }
  ]
}
```

| Field             | Type    | Required | Description                                                        |
| ----------------- | ------- | -------- | ------------------------------------------------------------------ |
| `id`              | string  | Yes      | Unique identifier                                                  |
| `name`            | string  | Yes      | Primary display name (fallback)                                    |
| `localizedNames`  | object  | No       | Localized names by language code (e.g., `{ "de": "Weihnachten" }`) |
| `emoji`           | string  | No       | Emoji for the holiday (default: 📅)                                |
| `startMonth`      | number  | Yes      | Start month (1-12)                                                 |
| `startDay`        | number  | Yes      | Start day (1-31)                                                   |
| `endMonth`        | number  | Yes      | End month (1-12)                                                   |
| `endDay`          | number  | Yes      | End day (1-31)                                                     |
| `sources`         | array   | Yes      | Content sources (at least one required)                            |
| `backgroundColor` | string  | No       | Banner background color (default: #333333)                         |
| `textColor`       | string  | No       | Banner text color (default: #FFFFFF)                               |
| `priority`        | number  | No       | Higher = takes precedence when holidays overlap                    |
| `enabled`         | boolean | No       | Enable/disable this holiday (default: true)                        |

#### Year-Wrapping Holidays

For holidays that span across years (e.g., New Year's), set `startMonth` > `endMonth`:

```json
{
    "id": "newyear",
    "startMonth": 12,
    "startDay": 28,
    "endMonth": 1,
    "endDay": 7
}
```

## Content Sources

### TMDB Source

Discovers content from The Movie Database using keywords, collections, and genres.

```json
{
    "type": "tmdb",
    "keywordIds": [207317, 6152],
    "keywords": ["christmas", "santa claus"],
    "genreIds": [10751, 35],
    "collectionIds": [9888, 743824],
    "featuredMovieIds": [771, 772],
    "featuredTvIds": [1972],
    "includeNewReleases": true,
    "minVoteCount": 50,
    "minVoteAverage": 5.5
}
```

| Field                | Type     | Description                                     |
| -------------------- | -------- | ----------------------------------------------- |
| `keywordIds`         | number[] | TMDB keyword IDs for discovery                  |
| `keywords`           | string[] | Text keywords for search fallback               |
| `genreIds`           | number[] | Filter by genre IDs                             |
| `collectionIds`      | number[] | Include movies from these collections           |
| `featuredMovieIds`   | number[] | Specific movie IDs to feature (boosted ranking) |
| `featuredTvIds`      | number[] | Specific TV show IDs to feature                 |
| `includeNewReleases` | boolean  | Include current/last year releases              |
| `minVoteCount`       | number   | Minimum vote count filter (default: 50)         |
| `minVoteAverage`     | number   | Minimum rating filter (default: 5.5)            |

**Finding TMDB IDs:**

- Keywords: `https://www.themoviedb.org/keyword/207317` (number in URL)
- Collections: `https://www.themoviedb.org/collection/9888`
- Movies/TV: `https://www.themoviedb.org/movie/771`

### MDBList Source

Fetches content from MDBList playlists.

```json
{
    "type": "mdblist",
    "listPath": "lists/christmas-movies",
    "limit": 50,
    "boostFactor": 1.5
}
```

| Field         | Type   | Description                             |
| ------------- | ------ | --------------------------------------- |
| `listPath`    | string | **Required.** Path to the MDBList list  |
| `limit`       | number | Maximum items to fetch                  |
| `boostFactor` | number | Ranking boost multiplier (default: 1.0) |

### Custom Source

Specify exact TMDB IDs for complete control.

```json
{
    "type": "custom",
    "movieIds": [771, 772, 773],
    "tvIds": [1972, 1973],
    "boostFactor": 5.0
}
```

| Field         | Type     | Description                             |
| ------------- | -------- | --------------------------------------- |
| `movieIds`    | number[] | TMDB movie IDs                          |
| `tvIds`       | number[] | TMDB TV show IDs                        |
| `boostFactor` | number   | Ranking boost multiplier (default: 5.0) |

## Pre-Holiday Period

Show a different banner/emoji before the main holiday:

```json
{
    "id": "christmas",
    "startMonth": 11,
    "startDay": 20,
    "endMonth": 12,
    "endDay": 27,
    "preHoliday": {
        "name": "Getting into Christmas spirit?",
        "localizedNames": { "de": "Schon in Weihnachtsstimmung?" },
        "emoji": "🕯️",
        "startMonth": 11,
        "startDay": 20,
        "endMonth": 12,
        "endDay": 22
    }
}
```

During Nov 20 - Dec 22, users see the Advent messaging. Dec 23-27 shows the main Christmas banner.

## Content Validation

Filter out irrelevant content that matches keywords but isn't holiday-themed:

```json
{
    "validation": {
        "requiredTerms": ["christmas", "xmas", "santa"],
        "excludeTerms": ["horror", "slasher"],
        "skipForFeatured": true
    }
}
```

| Field             | Type     | Description                                     |
| ----------------- | -------- | ----------------------------------------------- |
| `requiredTerms`   | string[] | Title/overview must contain at least one term   |
| `excludeTerms`    | string[] | Exclude if title/overview contains any term     |
| `skipForFeatured` | boolean  | Don't validate featured content (default: true) |

## Priority & Overlap

When holidays overlap, `priority` determines which is shown:

```json
{ "id": "christmas", "priority": 10 },  // Highest priority
{ "id": "newyear", "priority": 8 }
```

If priorities are equal, the first holiday in the config file is used.

## API Endpoint

```
GET /api/recommendations/holiday
```

Query parameters:

- `limit` - Number of recommendations (max: 100)
- `refresh` - Force cache refresh (`true`/`false`)

Response:

```json
{
  "success": true,
  "data": {
    "active": true,
    "holiday": { "id": "christmas", "name": "Christmas", ... },
    "items": [...],
    "cached": false
  }
}
```

## Programmatic Usage

```typescript
import { holidayPlugin, getCurrentHoliday } from '$lib/server/plugins/holidays';

// Check current holiday
const holiday = getCurrentHoliday();
if (holiday) {
    console.log(`Active: ${holiday.name}`);
}

// Get recommendations
// `access` = the caller's library/age boundary (buildSearchAccessContext);
// it scopes library discovery and which items are marked available.
const result = await holidayPlugin.getRecommendations(username, {
    limit: 20,
    refresh: false,
    access,
});

// Reload config (production)
holidayPlugin.reload();
```

## Troubleshooting

### No Recommendations Showing

1. Check if the current date is within a holiday's date range
2. Verify `enabled: true` in both settings and the specific holiday
3. Check server logs for validation warnings
4. Ensure TMDB API key is configured

### Wrong Holiday Showing

1. Check `priority` values for overlapping holidays
2. Verify date ranges don't overlap unintentionally

### Stale Content

1. In development, changes are detected every 10 seconds
2. In production, restart the server or call `reloadConfig()`
3. Refresh the cache with `POST /api/recommendations/holiday/refresh` and a JSON body such as `{ "limit": 20 }`

### Log Messages

Key log messages to look for:

- `[HolidayConfigLoader] Loaded holiday config` - Config successfully loaded
- `Holiday has invalid sources that were skipped` - Source validation failed
- `Holiday preHoliday has invalid date fields` - Pre-holiday config error
- `High TMDB enrichment failure rate` - TMDB API issues
