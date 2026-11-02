# modal/

Media detail modal components — inner sections of the movie/episode detail overlay.

## Files

| File                           | What                                                                  | When to read                             |
| ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------- |
| `ModalHeader.svelte`           | Modal title bar with close button and backdrop                        | Modifying modal header layout            |
| `ModalBody.svelte`             | Modal main content area layout                                        | Modifying modal body structure           |
| `ModalActions.svelte`          | Action buttons row (play, watchlist, request, etc.)                   | Adding or modifying modal action buttons |
| `ModalAudiobookDetails.svelte` | Audiobook author/narrator/series/publisher + collapsible chapter list | Working on the audiobook detail modal    |
| `ModalSeasons.svelte`          | Season/episode picker within modal                                    | Implementing season navigation in modal  |
| `ModalTrailerOverlay.svelte`   | Full-bleed trailer overlay (local file, falls back to YouTube)        | Implementing trailer playback in modal   |
| `ActorChip.svelte`             | Inline actor chip with avatar                                         | Displaying actor credits in cast list    |
| `ActorModal.svelte`            | Full actor filmography modal                                          | Implementing actor detail view           |
| `DebugPanel.svelte`            | Dev-only debug info panel inside modal                                | Debugging media item data in development |
| `SocialReviewSection.svelte`   | User reviews and social activity section within modal                 | Implementing review display              |
| `index.ts`                     | Barrel export for modal components                                    | Importing modal sub-components           |
