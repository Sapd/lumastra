# Test Fixtures

## test-video.mp4

A synthetic 5-second H.264/AAC MP4 used as a test fixture for lumastra HLS playback tests.

Generated with:

```bash
ffmpeg -f lavfi -i "testsrc=duration=5:size=320x240:rate=24" \
       -f lavfi -i "sine=frequency=440:duration=5" \
       -c:v libx264 -preset ultrafast -crf 40 \
       -c:a aac -b:a 32k \
       -movflags +faststart \
       -y tests/fixtures/test-video.mp4
```

To regenerate: delete the file and run the command above.

## watch-together/

`wt-movie-240s.mp4` (240 s, ~1.2 MB) and `wt-episode-60s.mp4` (60 s, ~0.3 MB) for the
web-only Watch Together e2e (`tests/watch-together/`, `playwright.watch-together.config.ts`).
H.264 High 640x360 24 fps (2 s GOP, so seeks land on a nearby keyframe) + a SILENT AAC
stereo track (the tests make no sound in any browser, real Safari included, without
touching the element's `muted` state that the autoplay test depends on) —
browser-native, so the e2e uses direct play and needs no ffmpeg at run time. Verified to
decode in Playwright's bundled Linux Chromium (headless shell and full), 2026-10-01.
`testsrc` keeps the files small and shows a frame counter in failure screenshots.

```bash
gen() {
  ffmpeg -y -f lavfi -i "testsrc=duration=${2}:size=640x360:rate=24" \
         -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" -t "${2}" \
         -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 45 \
         -g 48 -keyint_min 48 -sc_threshold 0 \
         -c:a aac -b:a 32k -ac 2 -movflags +faststart "tests/fixtures/watch-together/${1}.mp4"
}
gen wt-movie-240s 240
gen wt-episode-60s 60
```
