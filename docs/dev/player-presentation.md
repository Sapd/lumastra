# Player presentation

`src/lib/components/player/PlayerIcon.svelte` owns the transport and playback
icons used by the real player and the public demo. Its paths preserve the
production icons. `player-presentation.css` owns the shared dark translucent
menu/drawer surface, focus ring, header and section typography. Component styles
still own placement, scrolling and interaction-specific layouts.

## Surface inventory

| Surface                       | Components / nested controls                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio and subtitles           | `TrackSelector`, full localized language names, track descriptions, forced-subtitle toggle, default-language action, burn-in status                              |
| Subtitle appearance           | `SubtitleStyleSelector`, presets, font, size, height and reset                                                                                                   |
| Quality and advanced playback | `QualitySelector`, source/version choices, quality profiles, audio-only, playback information, autoplay/countdown, skip intro/credits                            |
| Speed                         | `SpeedSelector`; opening tracks or quality closes the speed menu                                                                                                 |
| Movie information             | `MovieSidebar`, fixed header, synopsis, real chapter seeks, optional cast; existing ratings, watchlist, abandon and similar-title actions retained               |
| Episodes and seasons          | `EpisodeBrowser`, nested season picker, two-line titles, wrapping metadata, current/watched/progress state; `EpisodeOverviewHoverPanel` and next-episode preview |
| Playlists and channels        | `PlaylistBrowser`, `ChannelSwitcher`                                                                                                                             |
| Community notes and reactions | `AnnotationsSidebar`, `AnnotationPopup`, `ReactionOverlay`                                                                                                       |
| Watch Together                | `WatchTogetherOverlay`, active-session panel and host-transfer menu; `WatchPartyBackDialog`                                                                      |
| Other dialogs                 | `TabConflictModal`, `SeriesFinishedCard`; `Search` opts in through `playerMode` only inside `VideoPlayer`                                                        |

Browser-owned fullscreen, Picture in Picture and AirPlay surfaces cannot be
restyled. Playback status overlays, skip buttons and muted-autoplay prompts keep
their existing purpose-specific layouts.

## Public demo synchronization

From the website checkout, run:

```sh
node scripts/sync-demo-ui.mjs /path/to/lumastra-app --player-only
```

This copies the icon component and CSS verbatim and records their source hashes
in `src/components/demo/upstream/manifest.json`. The website test suite verifies
that neither copy has drifted from its recorded hash. Do not edit the generated
copies independently. The full sync command also refreshes hero/dock assets.

Playback state and media data remain separate. The demo uses fictional metadata
and silent sample clips. Series without a clip offer **Explore player** with
artwork, season/episode browsing and shared local watched markers; they do not
claim to play an episode. Real chapter buttons honor Watch Together guest
restrictions, and optional cast failures do not block the movie drawer.

## Validation

The component tests cover chapter selection/time conversion, current chapter,
guest restrictions, optional cast failure, menu exclusivity and existing episode,
quality, Watch Together and volume behavior. Browser review used local sample
data for production menus and checked desktop and 390px phone layouts, including
scrolling in expanded subtitle/advanced settings. The temporary visual fixture
is not part of the application.
