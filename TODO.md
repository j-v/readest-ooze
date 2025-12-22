next step

to test

- is online audio still working - YES, when started in online
- test offline->online fallback working - NO

issues with offline audio

- Kokoro issues:
  - bad: Kaiser Wilhelm’s - good: Kaiser Wilhelm's -- need to replace all instances of ’s with 's.. do it on the server?
- doesn't switch to offline if started in online TTS (maybe fixed?)
- can web app be run offline? (specifically in iOS)
- error handling
  - no matching audio chunk
- cancel download doesn't work (at least not immediately)
- nested chapters might not make sense in TOC?
- trying to download TTS when offline doesn't fail gracefully
- partial success of download looks like complete success

offline audio improvements

- progress meter for download
- better audio-text synchronization / highlight tracking

TTS issues

- text breaking in Meditations
- Names with abbrevs as separate sentences
- trying to start online TTS with no connection not handled gracefully

build/deploy issues

- pnpm preview/build for cloudfare requires: export NODE_OPTIONS="--max-old-space-size=8192"
- TOO BIG FOR CLOUDFLARE. (exceeded size limit of 3MiB) Try Vercel?
