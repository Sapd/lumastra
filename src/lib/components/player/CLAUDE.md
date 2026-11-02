# player/

Video player components and supporting logic — HLS playback, controls, session reporting, and watch-together integration.

## Files

| File                                 | What                                                                                  | When to read                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `VideoPlayer.svelte`                 | Thin template shell — imports PlayerController, renders UI                            | Modifying player template/layout                       |
| `player-controller.svelte.ts`        | All player logic — state, effects, event handlers, lifecycle                          | Modifying player behavior, debugging playback          |
| `PlayerOverlay.svelte`               | Overlay UI layer (OSD, controls, notifications)                                       | Modifying player HUD or overlay elements               |
| `PlayerControls.svelte`              | Playback control bar (play/pause/seek/volume)                                         | Modifying control bar layout or behavior               |
| `playerStore.svelte.ts`              | Reactive player state store (Svelte 5 runes: $state, $derived)                        | Reading or writing player state                        |
| `playerStore.test.ts`                | Player store unit tests                                                               | Testing player state transitions                       |
| `playback-manager.ts`                | Manages HLS.js lifecycle, source switching, and error recovery                        | Debugging stream failures, implementing new play modes |
| `playback-decision.ts`               | Determines direct play vs transcode based on capabilities                             | Implementing playback method selection                 |
| `playback-display.ts`                | Display metadata helpers (title, episode info, progress)                              | Modifying what info is shown during playback           |
| `playback-restart.ts`                | Resume-from-position and restart-after-error logic                                    | Fixing seek/resume bugs                                |
| `hls-config.ts`                      | HLS.js configuration factory                                                          | Tuning HLS buffer sizes, error recovery                |
| `stream-url-builder.ts`              | Builds HLS and direct-play stream URLs                                                | Adding new stream URL formats                          |
| `adaptive-bitrate.ts`                | ABR quality selection logic                                                           | Implementing adaptive bitrate features                 |
| `adaptive-drift-compensator.ts`      | Compensates for clock drift in live streams                                           | Debugging live TV sync issues                          |
| `adaptive-drift-compensator.test.ts` | Drift compensator tests                                                               | Testing drift compensation                             |
| `play-session-reporter.ts`           | Reports play events to the server (start/progress/stop)                               | Implementing session reporting or fixing event gaps    |
| `play-session-reporter.test.ts`      | Session reporter tests                                                                | Testing session reporting logic                        |
| `restart-orchestrator.ts`            | Coordinates full player restart (source change, auth refresh)                         | Implementing source switching or auth token refresh    |
| `telemetry.ts`                       | Sends beacon telemetry events (`navigator.sendBeacon`)                                | Implementing playback analytics                        |
| `preferences-sync.svelte.ts`         | Syncs user playback preferences to/from server (Svelte 5)                             | Implementing preference persistence                    |
| `osd-indicators.svelte.ts`           | On-screen display indicator state (Svelte 5)                                          | Adding new OSD indicators                              |
| `timing-constants.ts`                | Shared timing constants (heartbeat intervals, seek debounce)                          | Tuning timing behavior                                 |
| `language-utils.ts`                  | Audio/subtitle language code utilities                                                | Implementing language selection                        |
| `$lib/shared/track-selection.ts`     | Audio/subtitle resolution shared with the server — preference order and its rationale | Changing which track playback starts on                |
| `subtitle-renderer.ts`               | External subtitle rendering (SRT/VTT to canvas)                                       | Debugging subtitle display                             |
| `subtitle-utils.ts`                  | Subtitle track utilities (parsing, selection)                                         | Implementing subtitle features                         |
| `codec-support.ts`                   | Browser codec capability detection                                                    | Implementing codec-aware playback decisions            |
| `codec-types.ts`                     | TypeScript types for codec support                                                    | Using codec types                                      |
| `browserCapabilities.svelte.ts`      | Browser feature detection (HDR, DolbyVision, Svelte 5)                                | Implementing hardware capability checks                |
| `native-bandwidth.ts`                | Reads native HLS bandwidth estimation                                                 | Integrating network bandwidth into ABR                 |
| `safari-types.ts`                    | Safari-specific Media Source Extension types                                          | Implementing Safari-specific HLS workarounds           |
| `video-input.ts`                     | Video element input/source management                                                 | Debugging video element setup                          |
| `player-utils.ts`                    | Miscellaneous player utility functions                                                | Using player helpers                                   |
| `volume-control.ts`                  | Volume and mute state management                                                      | Implementing volume features                           |
| `volume-control.test.ts`             | Volume control tests                                                                  | Testing volume logic                                   |
| `watch-together-handlers.ts`         | Handles watch-together sync events in the player                                      | Implementing watch-party synchronization               |
| `index.ts`                           | Barrel export for player module                                                       | Importing from player module                           |
| `AnnotationPopup.svelte`             | Inline annotation popup component                                                     | Implementing annotation display                        |
| `AnnotationsSidebar.svelte`          | Annotations panel sidebar                                                             | Building annotations sidebar                           |
| `AutoplayMutedPrompt.svelte`         | Prompt shown when autoplay requires muted start                                       | Implementing autoplay UX                               |
| `ChannelSwitcher.svelte`             | Live TV channel switching UI                                                          | Implementing channel navigation                        |
| `EpisodeBrowser.svelte`              | In-player episode list browser                                                        | Implementing in-player episode navigation              |
| `LiveTvOverlay.svelte`               | Live TV specific overlay (EPG info, recording)                                        | Implementing live TV HUD                               |
| `MovieSidebar.svelte`                | Movie details sidebar panel in player                                                 | Implementing player sidebar                            |
| `PlaylistBrowser.svelte`             | In-player playlist browser                                                            | Implementing playlist navigation in player             |
| `ProgressBar.svelte`                 | Seekable progress / timeline bar                                                      | Modifying seek bar behavior                            |
| `QualitySelector.svelte`             | Manual quality selection dropdown                                                     | Implementing quality selector UI                       |
| `ReactionOverlay.svelte`             | Watch-together reaction emoji overlay                                                 | Implementing reaction animations                       |
| `ScreenEffectsOverlay.svelte`        | Full-screen visual effects overlay                                                    | Adding screen effects                                  |
| `SpeedSelector.svelte`               | Playback speed selection                                                              | Implementing playback speed control                    |
| `SubtitleStyleSelector.svelte`       | Subtitle style customization UI                                                       | Implementing subtitle appearance settings              |
| `ToggleSwitch.svelte`                | Reusable toggle switch (player-specific)                                              | Using toggle in player controls                        |
| `TrackSelector.svelte`               | Audio/subtitle track selection                                                        | Implementing track switching                           |
| `VideoOverlays.svelte`               | Composites all video overlay layers                                                   | Debugging overlay rendering order                      |
| `VolumeControl.svelte`               | Volume slider and mute button                                                         | Implementing volume UI                                 |
| `WatchPartyBackDialog.svelte`        | Confirm dialog for leaving a watch party                                              | Implementing watch party exit flow                     |
| `WatchTogetherOverlay.svelte`        | Watch-together participant overlay                                                    | Implementing watch party HUD                           |
| `WatchTogetherToast.svelte`          | Watch-together event toast notifications                                              | Implementing watch party notifications                 |

## Subdirectories

| Directory    | What                                       | When to read                             |
| ------------ | ------------------------------------------ | ---------------------------------------- |
| `controls/`  | Hover-preview filmstrip overlay components | Implementing seek preview UI             |
| `trickplay/` | Trickplay thumbnail loader                 | Implementing trickplay thumbnail loading |

## iOS Safari native HLS traps

iOS Safari plays HLS through AVFoundation, which is stricter than desktop Safari and than macOS
AVFoundation. Three rules keep iPhone/iPad web playback working; each one was a real failure.

- **iPhone/iPad web gets separate audio (demux), never muxed copy-HLS.** Muxed fMP4 with AC-3
  audio and no master playlist made iOS add and drop the audio track every ~100 ms and cancel
  the first segment each time, so playback looped for up to a minute or failed. The web player
  sends caps token `da:1` (`hlsDemuxAudio` in `browserCapabilities.svelte.ts`, parsed in
  `server/utils/info.utils.ts`), and `PlaybackPlannerService.resolveHlsAudioMode` then picks
  `demux`: a master with CODECS and the audio as EXT-X-MEDIA renditions. Tests:
  `playback-planner-parity.test.ts` ("prefers separate audio (iOS)"),
  `browserCapabilities.serialize.test.ts`.
- **Masters served to the web player carry no SUBTITLES renditions.** The player renders
  subtitles from its own `<track>` elements and never reads them from the manifest. The web
  route (`/api/playback/...`) sets `omitManifestSubtitles`; `/api/v1` and `/j` keep their
  subtitle renditions for native apps. Test: `playback.service.test.ts` ("leaves subtitle
  renditions out of the master for the web player").
- **On iOS, attach `<track>` elements only after `loadedmetadata`, and remove them before every
  new `src`.** iOS hands every `<track>` child present when a load starts to AVFoundation as an
  out-of-band subtitle track, and next to any HLS master that fails the whole load
  (AVFoundation -11800 / -50 on the media-selection options, MediaError 4), even when the
  master has no subtitles of its own. `PlaybackManager` fires `onBeforeSourceChange` before each `src`
  assignment; the controller's `detachSubtitleTracksBeforeLoad()` removes the tracks there, and
  `loadSubtitles()` waits for `loadedmetadata` on iOS. Test: `playback-manager.test.ts`
  ("fires onBeforeSourceChange before the native source is set"). The controller side has no
  unit test; check subtitles on a real iPhone after changing it.

macOS AVFoundation plays streams that iOS rejects, so a Mac test does not prove an iOS fix. See
`docs/dev/testing-traps.md`, "Debugging playback on iOS Safari".
