<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="Stream Inspector icon">
</p>

<h1 align="center">Stream Inspector</h1>

<p align="center">
  A Chrome extension that shows the real codec, bitrate, resolution and frame rate<br>
  of any video you watch: YouTube, Twitch, Netflix, plain video files, WebRTC.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3">
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen.svg" alt="No dependencies">
</p>

---

## Features

- **Codec, decoded into plain words**: `vp09.02.41.10.01.09.16` becomes
  *VP9 · Profile 2 · L4.1 · 10-bit* with an **HDR10** badge. Supports H.264, HEVC, VP8, VP9, AV1,
  Dolby Vision, AAC / HE-AAC, Opus, Vorbis, FLAC, Dolby Digital (Plus), DTS and more.
- **Real bitrate**, separately for video and audio, measured from the compressed data Chrome
  actually decodes, with the average, the peak and a 60-second graph.
- **Downloading bitrate**: the quality of the segments being buffered, so you see a quality switch before it reaches the screen.
- Resolution, frame rate, dropped frames, buffer length, live/VOD, container and DRM system
  (Widevine, PlayReady, …).
- Works with adaptive streams (MSE: YouTube, Twitch, Netflix, most players), plain video files (reads the MP4/WebM header)
  and WebRTC (video calls, cloud gaming).
- A stats panel on each video, a toolbar popup, and a settings page with a size slider and
  customizable keyboard shortcuts.
- No dependencies, no build step, no tracking.

## Install

Stream Inspector isn't on the Chrome Web Store yet. To install it from source:

1. Download this repository (**Code → Download ZIP**, then unzip it) or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Reload any tabs that were already open, then play a video.

It also works in other Chromium browsers (Edge, Brave, Opera, Vivaldi).

## Usage

- The panel appears in the top-left corner of every playing video. Click its title bar to
  collapse it to one line, or **×** to hide it for that video.
- Click the toolbar icon to see the same stats in a popup. The gear icon opens **Settings**.

| Default shortcut | Action |
|---|---|
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Show / hide stats |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | Collapse / expand |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>=</kbd> | Bigger panel |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>-</kbd> | Smaller panel |

All shortcuts can be changed in Settings. They're matched by physical key, so they work with
any keyboard layout.

## How it works

| Stat | Where it comes from |
|---|---|
| Codec | Players hand the browser a codec string when they set up playback (`MediaSource.addSourceBuffer`). The extension records it and also parses the stream's init segments, which describe the quality level actually playing. For plain files, it reads the MP4 (`stsd`/`avcC`/`hvcC`/`av1C`/`vpcC`/`esds`) or WebM (`CodecID`) header. |
| Bitrate | Chrome counts the compressed bytes it hands to the decoders (`webkitVideoDecodedByteCount` / `webkitAudioDecodedByteCount`). The change in those counts over the media time played gives the bitrate of what's on screen. |
| Downloading | Bytes appended to each `SourceBuffer` divided by the seconds of media they added. |
| Frames | `HTMLVideoElement.getVideoPlaybackQuality()` |
| WebRTC | `RTCPeerConnection.getStats()` inbound-rtp and codec reports, matched to the video's tracks. |
| DRM | The key system passed to `MediaKeySystemAccess.createMediaKeys`. |

To see these calls, a small script runs in the page before the site's own code
(`world: "MAIN"`, `document_start`). It wraps those APIs with transparent proxies and never
changes their behavior.

## Privacy

Stream Inspector collects nothing and sends nothing anywhere. All stats are computed locally
and never leave your browser. The only network requests it makes are small reads of the start
(and sometimes the end) of a video file you're already playing, to find its codec. Only the
codec name is passed back to the page, never the file contents.

It asks for access to all sites because it needs to observe video players wherever you watch
them.

## Limitations

- Tabs opened before the extension was installed show bitrate only until they're reloaded.
- Players that run their media pipeline in a Web Worker, or draw video with WebCodecs/canvas
  instead of a `<video>` element, can't be inspected.
- If a site makes the bare `<video>` element fullscreen (instead of its player container),
  the panel can't be shown over it. The popup still works.
- Shortcuts work while a web page has focus (not in the address bar or on `chrome://` pages).

## Project structure

```
manifest.json
src/
  inject.js      page script: API hooks, measurements, the stats panel
  sniff.js       MP4 / WebM header parser (used in the page and the background worker)
  shared.js      settings defaults and shortcut helpers
  bridge.js      content script: relays settings, handles shortcuts
  background.js  service worker: cross-origin file-header reads
popup/           toolbar popup
options/         settings page
icons/           extension icons (generated by tools/make-icons.js)
tools/           dev scripts
```

## Contributing

Issues and pull requests are welcome. There's no build step: edit the files, then click the
reload button on the extension's card in `chrome://extensions` and reload the test tab.

## License

[MIT](LICENSE)
