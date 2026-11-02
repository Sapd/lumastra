# stores/

Svelte stores for client-side state management.

## Files

| File                       | What                             | When to read                                                               |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `toast.store.ts`           | Toast notification system        | Implementing notifications, user feedback                                  |
| `modal.store.ts`           | Modal state management           | Implementing modal dialogs                                                 |
| `modal-url-sync.ts`        | Modal URL synchronization        | Implementing modal routing, deep linking                                   |
| `appConfig.ts`             | Application configuration store  | Accessing app config, branding, feature flags                              |
| `uiPreferences.ts`         | UI preference settings           | Implementing user preferences, theme                                       |
| `watch-navigation.ts`      | Watch URL helpers and navigation | Navigating to internal player                                              |
| `playerNavigation.ts`      | Player navigation state          | Implementing player UI                                                     |
| `playlists.ts`             | Playlist state                   | Implementing playlist features                                             |
| `watchlist.ts`             | Watchlist state                  | Implementing watchlist features                                            |
| `azBrowse.ts`              | A-Z browse state                 | Implementing A-Z browse features                                           |
| `watchTogether.svelte.ts`  | Watch party client store (SSE)   | Implementing watch party features (see also `watchTogether/` subdirectory) |
| `request-notifications.ts` | Request notification state       | Implementing request notifications                                         |
| `run-sse-bus.ts`           | Admin task run event bus (SSE)   | Implementing admin task monitoring                                         |
| `dock.store.ts`            | Icon-dock label preference       | Working on the left rail or the main content's left gutter                 |

## Subdirectories

| Directory        | What                      | When to read                      |
| ---------------- | ------------------------- | --------------------------------- |
| `watchTogether/` | Watch party store modules | Implementing watch party features |
