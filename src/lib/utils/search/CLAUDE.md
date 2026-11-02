# utils/search/

Search-specific client utilities — query parsing, result transformation, and API execution.

## Files

| File                      | What                                                    | When to read                              |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `query-parser.ts`         | Search query parser (operators, filters)                | Parsing search input, extracting filters  |
| `transformers.ts`         | Search result transformation to UniversalMediaItem      | Converting search results for display     |
| `search-helpers.ts`       | Search utility helpers                                  | General search helper functions           |
| `media-external-links.ts` | External service link handlers (Kavita, Audiobookshelf) | Opening items in external services        |
| `item-open-handlers.ts`   | Dispatch map for media type open actions (ref: DL-005)  | Adding/modifying how items open in search |
| `search-execution.ts`     | Parallel search group execution, stale-result detection | Modifying search API call strategy        |
