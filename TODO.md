next step
- deploy as app

issues with offline audio
- lag in starting offline audio in airplane mode/no connection..
- doesn't switch to offline if started in online TTS
- can web app be run offline? (specifically in iOS)
- progress completely broken?
- navigation (next/prev sentence) broken because of structure of SMLL chunks
  - next section works 
- error handling
 - no matching audio chunk
- cancel doesn't work (at least not immediately)

offline audio improvements
- custom voice
- custom playback speed
- better audio-text synchronization / highlight tracking
- handle audio playback across page turns
- persist playback position/state
- fallback when SMLL structure doesn't match

TTS issues
- text breaking in Meditations
- Names with abbrevs as separate sentences
- trying to start online TTS with no connection not handled gracefully

build/deploy issues
- pnpm preview/build for cloudfare requires: export NODE_OPTIONS="--max-old-space-size=8192"
- TOO BIG FOR CLOUDFLARE. (exceeded size limit of 3MiB) Try Vercel?
