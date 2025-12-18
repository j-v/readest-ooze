next step
- fix lock screen and media controls no longer working

to test
- is online audio still working
- test offline->online fallback working

issues with offline audio
- sometimes highlights word by word instead of sentences
- doesn't switch to offline if started in online TTS (maybe fixed?)
- can web app be run offline? (specifically in iOS)
- progress completely broken?
- navigation (next/prev sentence) broken because of structure of SMLL chunks
  - next section works 
- error handling
 - no matching audio chunk
- cancel download doesn't work (at least not immediately)
- doesn't seem to continue when locking screen
- nested chapters might not make sense in TOC?
- trying to download TTS when offline doesn't fail 
- changing playback speed results in "no matching audio chunk found for content" (same root cause as navigation broken probably)

offline audio improvements
- progress meter for download
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
