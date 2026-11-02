# README preview assets

The README images are captured from Lumastra's local interactive website demo,
using fictional AI-generated artwork, channel logos, profiles and silent trailers.
They are labelled as demo captures in the README; they are not production-user
screenshots or evidence of complete backend workflows.

Exception: `livetv-adaptive.webp` is a crop of the Live TV player's quality badges and
adaptive bitrate menu on a real install. The channel name and the picture are cropped out.

## Reproduce

1. In the website repository, build and serve the homepage on localhost:
   `npm run build`, then `npm run preview -- --host 127.0.0.1 --port 4321`.
2. In this repository, install the existing JavaScript dependencies and Playwright's
   Chromium browser. Python with Pillow is required for GIF encoding; Gifsicle optimizes the final file.
3. Capture the demo:

    ```sh
    node docs/assets/screenshots/capture-demo.mjs http://localhost:4321/
    python docs/assets/screenshots/encode-demo-gif.py .tmp-readme-capture/js .tmp-readme-capture/home-scroll-raw.gif
    gifsicle -O3 --lossy=80 --resize-width 600 .tmp-readme-capture/home-scroll-raw.gif -o docs/assets/screenshots/home-scroll.gif
    ```

4. Review the animation and the five WebP captures in `.tmp-readme-capture/js/`.
   Copy `home.webp`, `browse.webp`, `detail.webp`, `music.webp` and `livetv.webp`
   into this directory after inspection. Do not commit temporary PNG frames.

The capture script accepts an optional output directory as its second argument.
Use `--stills-only` after both positional arguments to refresh just the gallery.
It refuses non-local hosts and uses a fresh, unauthenticated browser context.
The capture-only stylesheet isolates the demo frame and removes focus outlines;
no production UI or data is modified.

## Animation

- 5.5 seconds at the top, showing the actual silent hero video sampled at 20 fps.
- 18 seconds of JavaScript-controlled scrolling, eased in and out.
- Brief pauses at two intermediate positions, then two seconds at the calendar.
- A shared 192-color palette with reserved brand/UI accents; 600 px wide, with the final file kept below 10 MB for GitHub.
- Final GIF resampled to 15 fps with 60/70 ms timing, preserving the full 27.3-second duration.
- Video timing is sampled explicitly so a slower capture machine cannot speed up
  the trailer. Scroll positions are calculated per frame, not captured wheel jumps.
