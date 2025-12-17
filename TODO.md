next step
- fix lock screen and media controls no longer working

to test
- is online audio still working
- test offline->online fallback working

issues with offline audio
- doesn't switch to offline if started in online TTS
- can web app be run offline? (specifically in iOS)
- progress completely broken?
- navigation (next/prev sentence) broken because of structure of SMLL chunks
  - next section works 
- error handling
 - no matching audio chunk
- cancel doesn't work (at least not immediately)
- doesn't seem to continue when locking screen
- nested chapters might not make sense in TOC?



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
