# sections/

Server-driven UI section components — render `PageSection` configs from server data into carousels, grids, and hero layouts.

## Files

| File                         | What                                                        | When to read                                           |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `SectionRenderer.svelte`     | Routes a `PageSection` to the correct section component     | Understanding how server-driven UI sections are routed |
| `StandardSection.svelte`     | Carousel and grid section layout (most common section type) | Implementing new section layouts                       |
| `HeroSection.svelte`         | Full-width hero banner section                              | Implementing hero/featured content sections            |
| `FeaturedPickSection.svelte` | Editor's featured pick section with highlight styling       | Implementing featured pick display                     |
| `ListSection.svelte`         | Compact list-style section layout                           | Implementing list view sections                        |
| `CalendarSection.svelte`     | Upcoming episodes calendar section                          | Implementing calendar sections                         |
| `KeywordChipsSection.svelte` | Keyword/tag chip browsing section                           | Implementing tag-based navigation sections             |
| `LiveSessionSection.svelte`  | Active streaming sessions section                           | Implementing live session display                      |
| `index.ts`                   | Barrel export for sections module                           | Importing section components                           |
