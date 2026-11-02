# stats/

Personal viewing statistics components — charts, breakdowns, and overview cards.

## Files

| File                        | What                                                      | When to read                               |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `PersonalStatsPage.svelte`  | Top-level stats page layout — composes all stats sections | Modifying stats page structure             |
| `StatsOverview.svelte`      | Summary metrics row (total watch time, item count)        | Implementing stats summary display         |
| `WatchTimeChart.svelte`     | Watch time over time chart                                | Implementing watch time visualization      |
| `PeakHoursHeatmap.svelte`   | Heatmap of viewing activity by hour and day               | Implementing viewing pattern visualization |
| `GenreBreakdown.svelte`     | Pie/bar chart of watched genres                           | Implementing genre distribution display    |
| `TasteProfile.svelte`       | AI-derived taste profile visualization                    | Implementing taste profile display         |
| `CompletionAnalysis.svelte` | Episode/movie completion rate analysis                    | Implementing completion rate display       |
| `DeviceBreakdown.svelte`    | Watch activity per device breakdown                       | Implementing device usage stats            |
| `RatingBehavior.svelte`     | User rating distribution and patterns                     | Implementing rating behavior analysis      |
| `QualityStats.svelte`       | Video quality (resolution/codec) usage stats              | Implementing quality usage display         |
| `FunRecords.svelte`         | Fun personal records (longest binge, most in a day)       | Implementing fun stats section             |
| `KeywordCloud.svelte`       | Word cloud of frequently watched keywords/tags            | Implementing keyword visualization         |
| `EmptyStatsState.svelte`    | Empty state for stats when no history exists              | Customizing stats empty state              |
