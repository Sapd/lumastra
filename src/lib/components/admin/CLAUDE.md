# admin/

Admin panel components — monitoring, settings, token management, and plugin configuration.

## Files

| File                                | What                                                     | When to read                                 |
| ----------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `ActivePlaySessionsPanel.svelte`    | Live active play sessions display                        | Implementing session monitoring UI           |
| `BandwidthChart.svelte`             | Bandwidth usage chart visualization                      | Displaying bandwidth metrics                 |
| `ChartCard.svelte`                  | Generic chart container card                             | Wrapping charts in admin panels              |
| `DevModeSwitcher.svelte`            | Dev mode toggle for dev user switching                   | Implementing dev mode controls               |
| `FilesystemCacheSection.svelte`     | Filesystem cache stats and controls                      | Implementing filesystem cache admin          |
| `MediaRankCard.svelte`              | Media popularity ranking card                            | Displaying media ranking metrics             |
| `NamespaceTable.svelte`             | Cache namespace breakdown table                          | Displaying per-namespace cache stats         |
| `plugins/ExternalPluginCard.svelte` | Individual plugin status card                            | Displaying plugin health and status          |
| `PluginSettingsPanel.svelte`        | Plugin settings, inline, on the host settings components | Implementing plugin settings UI              |
| `ProgressBar.svelte`                | Admin-specific progress bar                              | Showing task or sync progress                |
| `ServiceHealthGrid.svelte`          | Grid of service health status indicators                 | Displaying service health dashboard          |
| `SettingInput.svelte`               | Generic setting input field                              | Building settings forms                      |
| `SettingSection.svelte`             | Settings section grouping container                      | Organizing settings into sections            |
| `StandaloneCacheSection.svelte`     | Standalone cache stats section                           | Implementing standalone cache admin panels   |
| `SubtitleCacheCard.svelte`          | Subtitle cache stats card                                | Displaying subtitle cache metrics            |
| `TimeframeSelector.svelte`          | Date/timeframe picker for analytics                      | Implementing analytics timeframe selection   |
| `TokenSuccessModal.svelte`          | Token creation success modal with copy UI                | Implementing post-token-creation flow        |
| `TokenTable.svelte`                 | Token management table with actions                      | Implementing token CRUD UI                   |
| `UserTable.svelte`                  | Admin user list table                                    | Implementing user management UI              |
| `WidgetConfigEditor.svelte`         | Widget layout and configuration editor                   | Implementing dashboard widget customization  |
| `ActionButton.svelte`               | Admin action button with loading state                   | Building admin action buttons                |
| `ActionModal.svelte`                | Confirm/action modal wrapper                             | Implementing destructive action confirmation |
| `index.ts`                          | Barrel export for admin components                       | Importing admin components                   |

## Subdirectories

| Directory     | What                                                              | When to read                             |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `embeddings/` | AI embedding status and lookup widgets                            | Implementing embedding admin features    |
| `inputs/`     | Dynamic form input components (text, bool, array, select, number) | Building dynamic plugin settings forms   |
| `navigation/` | Sidebar and navigation editor components                          | Implementing navigation customization UI |
| `playback/`   | Playback health monitoring components and badges                  | Implementing playback admin dashboard    |
| `settings/`   | Settings page utility components (search, sticky save)            | Building settings page UI                |
| `stats/`      | User ranking stats components                                     | Implementing user stats admin views      |
| `tasks/`      | Task status badge components (running, queued, error, etc.)       | Implementing task status display         |
| `tokens/`     | Token table cell components for the token management grid         | Implementing token management table      |
