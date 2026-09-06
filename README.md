# Vencord AV1 Fix (`DisableAv1`)

A Vencord userplugin to filter out AV1 video codec negotiation and prevent Linux system freezes/crashes when screensharing or streaming video in Discord.

## Problem

On Linux, Discord streaming often triggers severe system freezes, GPU driver hangs, or complete desktop crashes when hardware acceleration / VA-API / WebRTC attempts to encode or decode video using the AV1 codec.

This plugin disables AV1 codec negotiation, forcing Discord/WebRTC to fall back to stable codecs such as H.264 or VP8/VP9.

## Features

- Filters AV1 and associated RTX payload types from WebRTC SDP (`createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`).
- Seamless toggle in Vencord Plugin Settings.
- Works as a standard Vencord userplugin.

## Installation

Clone this repository into your Vencord `src/userplugins` directory:

```bash
cd Vencord/src/userplugins
git clone https://github.com/arikukaenbyou/vencord-AV1-fix.git
```

Then rebuild and inject Vencord:

```bash
cd Vencord
pnpm build
pnpm inject
```

## License

GPL-3.0-or-later
