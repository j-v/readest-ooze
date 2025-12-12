next step
- Figure out how to get it running on my phone

issues with offline audio
- iOS - cant long click to download
- not working in safari
- can web app be run offline? (specifically in iOS)
- progress completely broken?
- navigation (next/prev sentence) broken because of structure of SMLL chunks
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

build/deploy issues
- pnpm preview/build for cloudfare requires: export NODE_OPTIONS="--max-old-space-size=8192"
- TOO BIG FOR CLOUDFLARE. Try Vercel?
  
  ✘ [ERROR] A request to the Cloudflare API (/accounts/1a26511983cd1a8d8ea6c88f069822b6/workers/scripts/readest-ooze/versions) failed.

  Your Worker exceeded the size limit of 3 MiB. Please upgrade to a paid plan to deploy Workers up
  to 10 MiB. https://dash.cloudflare.com/1a26511983cd1a8d8ea6c88f069822b6/workers/plans [code:
  10027]
  To learn more about this error, visit:
  https://developers.cloudflare.com/workers/platform/limits/#worker-size


  If you think this is a bug, please open an issue at:
  https://github.com/cloudflare/workers-sdk/issues/new/choose


  🪵  Logs were written to "/home/jon/.config/.wrangler/logs/wrangler-2025-12-11_00-48-07_842.log"