# ui/

Generic reusable UI primitives — building blocks shared across all feature domains.

## Files

| File                        | What                                               | When to read                                 |
| --------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `UniversalMediaCard.svelte` | Primary media card renderer for server-driven UI   | Implementing media card display anywhere     |
| `MediaCarousel.svelte`      | Horizontal scrollable media carousel               | Implementing media carousels                 |
| `MediaHoverCard.svelte`     | Hover-state expanded media card                    | Implementing hover previews                  |
| `MediaPreviewPlayer.svelte` | Inline video preview player for hover cards        | Implementing video preview on hover          |
| `MediaActionButtons.svelte` | Watchlist, rating, request action buttons group    | Adding action buttons to media cards         |
| `WatchButton.svelte`        | Primary play/watch button                          | Implementing play action                     |
| `WatchlistButton.svelte`    | Add/remove watchlist toggle button                 | Implementing watchlist toggle                |
| `StarRating.svelte`         | Interactive star rating widget                     | Implementing rating input                    |
| `SendToTVButton.svelte`     | Cast to TV button                                  | Implementing send-to-device feature          |
| `ModalContainer.svelte`     | Modal overlay container (backdrop + positioning)   | Wrapping modal content                       |
| `ConfirmModal.svelte`       | Generic confirm/cancel dialog                      | Implementing destructive action confirmation |
| `Button.svelte`             | Base button component with variants                | Using consistent button styling              |
| `Card.svelte`               | Generic card container                             | Wrapping content in card layout              |
| `Badge.svelte`              | Status/label badge                                 | Displaying status labels                     |
| `Alert.svelte`              | Informational/warning/error alert                  | Displaying inline alerts                     |
| `Avatar.svelte`             | User avatar with fallback initials                 | Displaying user avatars                      |
| `ChipList.svelte`           | Horizontal chip/tag list                           | Displaying tag lists                         |
| `CollapsibleSection.svelte` | Expandable/collapsible content section             | Implementing accordion-like content          |
| `AccordionGroup.svelte`     | Group of collapsible sections                      | Building FAQ or settings accordions          |
| `DataTable.svelte`          | Generic sortable data table                        | Displaying tabular data                      |
| `EmptyState.svelte`         | Empty state placeholder with icon and message      | Showing empty lists or search results        |
| `ErrorMessage.svelte`       | Inline error message display                       | Showing validation or fetch errors           |
| `FormField.svelte`          | Form field wrapper with label and validation       | Building forms with validation               |
| `HeroVideoPlayer.svelte`    | Full-width background video player (homepage hero) | Implementing video background sections       |
| `IconDropdown.svelte`       | Dropdown triggered by an icon button               | Implementing icon-triggered menus            |
| `LoadingSpinner.svelte`     | Animated loading spinner                           | Showing loading state                        |
| `Skeleton.svelte`           | Generic skeleton loading primitive with shimmer    | Showing placeholder loading bars             |
| `LoadingState.svelte`       | Full-area loading placeholder                      | Showing section-level loading state          |
| `Pagination.svelte`         | Page navigation controls                           | Implementing paginated lists                 |
| `ProgressBar.svelte`        | Horizontal progress bar                            | Displaying progress values                   |
| `ProgressRadial.svelte`     | Circular/radial progress indicator                 | Displaying circular progress                 |
| `SearchInput.svelte`        | Search text input with icon                        | Building search inputs                       |
| `SectionHeader.svelte`      | Section title with optional action link            | Displaying section headings                  |
| `Select.svelte`             | Styled select dropdown                             | Building select inputs                       |
| `StatCard.svelte`           | Single statistic card with value and label         | Displaying metric values                     |
| `Tabs.svelte`               | Tab navigation component                           | Implementing tabbed content                  |
| `ToastContainer.svelte`     | Toast notification container                       | Rendering toast notifications                |
| `Toggle.svelte`             | Boolean toggle switch                              | Implementing boolean settings                |
| `Tooltip.svelte`            | Hover tooltip wrapper                              | Adding tooltips to elements                  |
| `index.ts`                  | Barrel export for UI module                        | Importing UI components                      |
