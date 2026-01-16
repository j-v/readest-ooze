next step

- look into https://github.com/readest/readest/pull/1858 existing PR for implementing custom TTS endpoint (OpenAI compatible)
- need to use tauriFetch for http? and configure CSP in tauri.conf?

to test

-- test the cache busting fix - then make PR

- is online audio still working - YES, when started in online
- test offline->online fallback working - NO

HTTP TTS server settings

- future improvements
  - "test endpoint" button
  - multiple endpoints
  - configuring voices
  - settings preserved in online account

issues with offline audio

- I think downloading parent of nested chapter downloads all children but they don't get recognized as downloaded (Hamlet Act V)
- cancel download doesn't work (at least not immediately)
- delete button not working in book menu?
- Kokoro issues:
  - bad: Kaiser Wilhelm’s - good: Kaiser Wilhelm's -- need to replace all instances of ’s with 's.. do it on the server?
  - Reading all caps passages letter by letter (as acronyms) instead of as words - e.g. MARCUS AURELIUS ANTONINUS
  - Roman numerals read as letters - e.g. III (should be 3, or 'the 3rd' ideally depending on context)
- doesn't switch to offline if started in online TTS
- can web app be run offline? (specifically in iOS)
- error handling
  - no matching audio chunk
- nested chapters might not make sense in TOC?
- trying to download TTS when offline doesn't fail gracefully
- partial success of download looks like complete success
- when downloading section - can close dialog and download continues, but re-opening dialog shows no progress as if it was never started

offline audio improvements

- batch chapter download
- delete audio when deleting book
- control to delete all audio to free up space
- better audio-text synchronization / highlight tracking
- add option to disable "http tts server" (prevent it hanging when the server is down)
- TTS API to batch phrases, may improve performance
- visual indicator to show offline audio is active
- show icon for failed download (red X?)

refactoring

- global/section download dialogs could be a single component
- voice availability logic could be shared between OfflineAudioManager and TTSController

TTS issues

- text breaking in Meditations
- Names with abbrevs as separate sentences (note - when offline it works better because it sends the entire paragraph instead of sentence by sentence)
- trying to start online TTS with no connection not handled gracefully
- can get into a state where there are 2 voices reading at the same time

build/deploy issues

- pnpm preview/build for cloudfare requires: export NODE_OPTIONS="--max-old-space-size=8192"
- TOO BIG FOR CLOUDFLARE. (exceeded size limit of 3MiB) Try Vercel?
- had to add option to allow insecure connections for my home TTS server

Github PRs,issues & discussions

- https://github.com/readest/readest/pull/1858 [WIP] feat: implement OpenAI TTS client and integrate with TTS controller #1858
- https://github.com/readest/readest/issues/258 FR: Add custom TTS engine. #258
