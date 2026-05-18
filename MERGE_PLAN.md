# Merge Plan: main → offline-audio

## Goal

Merge the `main` branch into `offline-audio`, adapting offline-audio's TTS
offline-save/playback features onto main's refactored TTS architecture (hook
extraction, per-section init, section-aware navigation).

## Context

- **Merge base**: `f85d6d4`
- **Main** extracted TTSControl's ~600 lines of inline logic into a
  `useTTSControl` hook (759 lines) + `useTTSMediaSession` hook (120 lines), and
  heavily refactored `TTSController` for per-section TTS initialization and
  section-aware page turning.
- **Offline-audio** added OfflineTTSClient, HttpTTSClient, OfflineAudioManager,
  OfflineAudioStorage, provider abstractions, an OfflineAudioDownload dialog,
  and modified TTSController / TTSControl / TTSIcon / TTSPanel in the old
  inline style.

## Key Decisions

| #   | Area                      | Decision                                                                                                                           |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hook architecture         | Integrate offline features into `useTTSControl` hook                                                                               |
| 2   | TTSController init        | Keep main's `onSectionChange` constructor param; layer offline params (`bookHash`, `sectionHref`, `voiceId`, `lang`) onto `init()` |
| 3   | EdgeTTSClient/Providers   | Keep both — `appService` param for Linux rate fix, providers for offline audio synthesis                                           |
| 4   | Submodules                | Use main's versions (foliate-js, tauri, tauri-plugins)                                                                             |
| 5   | BookMenu "Offline Audio"  | Position after Parallel Read section, before sync section                                                                          |
| 6   | TTSIcon isOffline bubble  | Keep as-is (clicking opens download dialog)                                                                                        |
| 7   | HTTP TTS feature flag     | Remove `NEXT_PUBLIC_ENABLE_HTTP_TTS`, use `settings.customTTSEndpoint.enabled` only                                                |
| 8   | tauri.conf.json           | Keep `com.readest-ooze` identifier, remove deeplink, accept main's CSP + webview-upgrade                                           |
| 9   | useLongPress.ts           | Use main's version (offline-audio changes are unused)                                                                              |
| 10  | Settings Custom TTS UI    | Rewrite using main's SettingsRow/SettingsSwitchRow primitives                                                                      |
| 11  | Global settings TTS panel | Reader-only for now                                                                                                                |

---

## File-by-file resolution

### 1. `TTSController.ts`

**Conflict**: Both branches heavily modified (~430 lines each). The merged file
must include the structural changes from both.

**Approach**: Start with main's version, then add offline-audio's features.

**Specific changes to apply on top of main's version**:

1. **New imports** (add after the existing `EdgeTTSClient` import):

   ```ts
   import { OfflineTTSClient } from './OfflineTTSClient';
   import { HttpTTSClient } from './HttpTTSClient';
   import { useSettingsStore } from '@/store/settingsStore';
   ```

2. **New client fields** (add after `ttsNativeClient`):

   ```ts
   ttsOfflineClient: TTSClient;
   ttsHttpClient: TTSClient | null = null;
   ttsHttpVoices: TTSVoice[] = [];
   ```

3. **Offline context tracking fields** (add after `ttsTargetLang`):

   ```ts
   #bookHash: string = '';
   #lastSectionHref: string = '';
   #voiceId: string = '';
   ```

4. **Constructor**: Instantiate `OfflineTTSClient` and conditionally
   `HttpTTSClient` inside the constructor body (after `this.ttsEdgeClient`):

   ```ts
   this.ttsOfflineClient = new OfflineTTSClient(this);
   ```

   and conditionally:

   ```ts
   const settings = useSettingsStore.getState().settings;
   if (settings.customTTSEndpoint.enabled) {
     this.ttsHttpClient = new HttpTTSClient(this, settings.customTTSEndpoint.endpoint);
   }
   ```

5. **`dispatchClientChange` method** — Add this new helper that dispatches a
   `tts-client-change` event so the UI can show/hide the offline indicator:

   ```ts
   dispatchClientChange() {
     this.dispatchEvent(new CustomEvent('tts-client-change', {
       detail: { isOffline: this.ttsClient.name === 'offline-tts' }
     }));
   }
   ```

6. **`init()` method** — Main's version is parameterless. Extend it to accept
   optional offline context params and do an offline-first check before
   initializing online clients. The merged signature and body:

   ```ts
   async init(bookHash?: string, sectionHref?: string, voiceId?: string, lang?: string) {
     // Store context for offline TTS updates during playback
     if (bookHash) this.#bookHash = bookHash;
     if (sectionHref) this.#lastSectionHref = sectionHref;
     if (voiceId) this.#voiceId = voiceId;

     // Always initialize offline client first (lightweight, no network calls)
     await this.ttsOfflineClient.init();

     // Check if offline audio is available BEFORE initializing any online clients
     if (bookHash && sectionHref && voiceId) {
       const hasOfflineAudio = await (
         this.ttsOfflineClient as OfflineTTSClient
       ).hasOfflineAudio(bookHash, sectionHref, voiceId, lang);

       if (hasOfflineAudio) {
         this.ttsClient = this.ttsOfflineClient;
         await this.ttsClient.setRate(this.ttsRate);
         this.dispatchClientChange();
         return; // skip online client init
       }
     }

     // Otherwise initialize online clients normally (main's existing code)
     const availableClients = [];
     if (await this.ttsEdgeClient.init()) {
       availableClients.push(this.ttsEdgeClient);
     }
     if (this.ttsNativeClient && (await this.ttsNativeClient.init())) {
       availableClients.push(this.ttsNativeClient);
       this.ttsNativeVoices = await this.ttsNativeClient.getAllVoices();
     }
     if (this.ttsHttpClient && (await this.ttsHttpClient.init())) {
       availableClients.push(this.ttsHttpClient);
       this.ttsHttpVoices = await this.ttsHttpClient.getAllVoices();
     }
     if (await this.ttsWebClient.init()) {
       availableClients.push(this.ttsWebClient);
     }
     // ... rest of main's init() logic
     this.dispatchClientChange();
     this.ttsWebVoices = await this.ttsWebClient.getAllVoices();
     this.ttsEdgeVoices = await this.ttsEdgeClient.getAllVoices();
   }
   ```

   **Important**: Preserve main's existing init body (voice preference loading,
   switching to preferred client) exactly as it is. Only add the offline-first
   check at the top and the `dispatchClientChange()` calls.

7. **After `#clearHighlighter()`**: Add these three methods from offline-audio
   (place them before `initViewTTS`):
   - `tryUseOfflineAudio(bookHash, sectionHref, voiceId, lang?)` — switches to
     OfflineTTSClient if audio is available. Uses `setContext()` +
     `hasOfflineAudio()`. Dispatches `clientChange`. Returns boolean.
   - `updateOfflineContextIfNeeded()` — called before each `speak()` when using
     offline TTS. Updates section context if section changed. Falls back to
     online via `disableOfflineAudio()` if no offline audio for new section.
     Returns boolean.
   - `disableOfflineAudio()` — reverts to preferred online client (based on
     `TTSUtils.getPreferredClient()`). Dispatches `clientChange`.

   **Copy these from the offline-audio branch at:**
   `git show offline-audio:apps/readest-app/src/services/tts/TTSController.ts`
   (lines ~163–250)

8. **`preloadNextSSML()`** — Add early return at the top for offline TTS:

   ```ts
   // Offline TTS doesn't use SSML preloading - skip to avoid highlight jumping
   if (this.ttsClient.name === 'offline-tts') return;
   ```

9. **`#speak()` method** — Main's version is the authoritative one. **Keep
   main's structure entirely** (per-section init, navigation handling,
   `#currentSpeakAbortController` tracking). Add the offline-aware parts:
   - After creating `speakAbortController`, add:
     ```ts
     const isUsingOffline = this.ttsClient.name === 'offline-tts';
     if (isUsingOffline) {
       await this.updateOfflineContextIfNeeded();
     }
     ```
   - In the catch block (after main's existing rejection logic), add the
     offline-to-online fallback (copy from offline-audio's `#speak()` catch
     block). This tries `disableOfflineAudio()` then retries with the online
     client.
   - In the finally block, use main's `speakAbortController` check pattern
     (offline-audio and main both track the current controller; use main's
     pattern but ensure the finally block checks `speakAbortController`).

10. **`getAllVoices()`** — Add HttpTTS voices to the returned groups. Find
    main's `getAllVoices()` and add after the Native voices group the HttpTTS
    voice group (copy from offline-audio's getAllVoices).

11. **`setVoice()`** — Add `dispatchClientChange()` after setting the voice
    (so the offline indicator updates if user switches voices while paused).

**⚠️ Critical design note about `OfflineTTSClient` context management**:

Offline-audio's `OfflineTTSClient` has a `setContext(bookHash, sectionHref,
voiceId, lang?)` method (on the `TTSClient` interface as an optional member).
This method stores the context for use by `hasOfflineAudio()` and `speak()`.
The methods above (`tryUseOfflineAudio`, `updateOfflineContextIfNeeded`) call
`setContext()` before checking availability.

The `OfflineTTSClient.setContext()` and `hasOfflineAudio()` signature in the
offline-audio implementation takes `(bookHash, sectionHref, voiceId, lang?)`.
Make sure the calls in TTSController match this signature.

---

### 2. `useTTSControl.ts` (the hook — main's new file)

**Not a conflict** (this file only exists on main), but it needs to be extended
with offline-audio features.

**Additions needed**:

1. **Imports** — add at the top:

   ```ts
   import { useSettingsStore } from '@/store/settingsStore';
   ```

2. **State** — add after the existing state declarations:

   ```ts
   const [isOffline, setIsOffline] = useState(false);
   ```

3. **Offline-aware init** in the TTS controller construction (find the section
   where `new TTSController(...)` is instantiated — around line ~300-350):

   After creating the controller, change the init call from `ttsController.init()`
   to include offline context:

   ```ts
   const bookId = bookKey.split('-')[0]!;
   const voiceId = ...; // get from settings or ttsPanel voice selection
   const currentHref = progress?.sectionHref || '';
   const initialLang = primaryLang || 'en';
   await ttsController.init(bookId, currentHref, voiceId, initialLang);
   ```

   **Important**: You'll need access to `progress`, `primaryLang`, and the
   currently selected voice. Study how `useTTSControl` gets `progress` (via
   `getProgress(bookKey)`) and `primaryLang` (from `getBookData`).

4. **`tts-client-change` event listener** — In the effect that attaches
   `tts-need-auth`, `tts-speak-mark`, `tts-highlight-mark`, also attach:

   ```ts
   const handleClientChange = (e: Event) => {
     const { isOffline: offline } = (e as CustomEvent).detail;
     setIsOffline(offline);
   };
   ttsController.addEventListener('tts-client-change', handleClientChange);
   ```

   And clean it up in the return.

5. **Expose `isOffline` in the hook's return value** — Add to the returned
   object so TTSControl.tsx can pass it to TTSIcon.

---

### 3. `TTSControl.tsx`

**Conflict**: Main extracted everything to a hook (thin wrapper, ~100 lines).
Offline-audio added offline-aware state inline.

**Resolution**: Use main's version entirely. The only changes needed:

1. Destructure `isOffline` from the `useTTSControl` hook return.
2. Pass `isOffline` to the `<TTSIcon>` component:
   ```tsx
   <TTSIcon
     isPlaying={isPlaying}
     ttsInited={ttsClientsInited}
     isOffline={isOffline}
     onClick={togglePopup}
   />
   ```

---

### 4. `TTSIcon.tsx`

**Not a conflict** (only changed on offline-audio, main didn't touch it).

Accept offline-audio's version entirely. It adds:

- `isOffline` prop
- Offline bubble indicator (MdFileDownload circle icon) that calls
  `setShowOfflineAudioDownload` on click
- Wrapping `<div>` around the button for the bubble layering

**No changes needed** — just use the offline-audio version. Verify the
`setShowOfflineAudioDownload` import is correct (from `useReaderStore`).

---

### 5. `TTSPanel.tsx`

**Conflict**: Main added `title`/`aria-label` accessibility attributes + removed
unused `React` import. Offline-audio added `MdFileDownload` icon and a download
button.

**Resolution**: Combine both. Start with main's version, then:

1. Add `MdFileDownload` import
2. Add `setShowOfflineAudioDownload` from `useReaderStore`
3. Add the download button before the chevron div at the bottom of the panel
   (same position as offline-audio)

---

### 6. `ReaderContent.tsx`

**Conflict**: Both branches added different modals and imports.

**Resolution**: Keep both branches' additions. The merged file needs:

- From main: ShareBookDialog imports/state/rendering, useGamepad, Discord
  presence, deep link handling, navigation changes
- From offline-audio: OfflineAudioDownload modal (ModalPortal import +
  OfflineAudioDownload import + rendering block)

Watch for the `showOfflineAudioDialog`/`offlineAudioBookKey` destructuring from
`useReaderStore` — main already destructures other readerStore values, so add
these alongside.

---

### 7. `BookMenu.tsx`

**Conflict**: Both restructured the menu significantly.

**Resolution**: Use main's version as base. Add the "Offline Audio" menu item
after Parallel Read section and before the sync section (its original position):

```tsx
<MenuItem label={_('Offline Audio')} Icon={MdDownload} onClick={handleShowOfflineAudio} />
<hr className='border-base-200 my-1' />
```

The handler:

```ts
const handleShowOfflineAudio = () => {
  setShowOfflineAudioDownload(sideBarBookKey);
  setIsDropdownOpen?.(false);
};
```

Include the `MdDownload` import from `react-icons/md`.

---

### 8. `useLongPress.ts`

**Conflict**: Both changed callback signatures differently. Offline-audio's
changes are unused (no callers depend on the event args it added).

**Resolution**: Use main's version entirely. Discard offline-audio's changes.

---

### 9. `appService.ts`

**Conflict**: Main massively restructured (1122 lines changed). Offline-audio
added 2 lines (import + default setting for `customTTSEndpoint`).

**Resolution**: Use main's version. Add the following:

1. Import `DEFAULT_CUSTOM_TTS_ENDPOINT_CONFIG` from `./constants`
2. Add `customTTSEndpoint: DEFAULT_CUSTOM_TTS_ENDPOINT_CONFIG` to the default
   settings object in `getDefaultSettings()` (or wherever the defaults are
   built in main's restructured version)

Find the exact location by searching for existing default settings assignments
in main's version (e.g. `globalViewSettings: ...`) and add the new line nearby.

---

### 10. `constants.ts`

**Conflict**: Both branches added to `DEFAULT_SYSTEM_SETTINGS`. Main added ~50+
settings. Offline-audio added `customTTSEndpoint`.

**Resolution**: Use main's version. Add at the bottom of `DEFAULT_SYSTEM_SETTINGS`:

```ts
customTTSEndpoint: DEFAULT_CUSTOM_TTS_ENDPOINT_CONFIG,
```

And add the `DEFAULT_CUSTOM_TTS_ENDPOINT_CONFIG` constant itself (from
offline-audio's version) somewhere near the other DEFAULT\_\* configs:

```ts
export const DEFAULT_CUSTOM_TTS_ENDPOINT_CONFIG = {
  enabled: false,
  endpoint: 'http://localhost:8000/tts',
};
```

---

### 11. `settings.ts` (types)

**Auto-merged** but needs verification. Open the file after merge and ensure
these exist:

- All of main's additions: `SyncCategory`, `ReadwiseSettings`,
  `HardcoverSettings`, `pinCodeEnabled`, `replicaDeviceId`,
  `lastSyncedAtReplicas`, `syncCategories`, `LibraryGroupByType`, etc.
- Offline-audio's addition at the bottom of `SystemSettings`:
  ```ts
  customTTSEndpoint: CustomTTSEndpointConfig;
  ```
  And the interface:
  ```ts
  export interface CustomTTSEndpointConfig {
    enabled: boolean;
    endpoint: string;
  }
  ```

---

### 12. `.env.local.example`

**Conflict**: Both added 1 line at the end.

**Resolution**: Keep only main's addition (`TEMP_STORAGE_PUBLIC_BUCKET_NAME`).
Do NOT add offline-audio's `NEXT_PUBLIC_ENABLE_HTTP_TTS` — we're removing that
feature flag per Decision #7.

---

### 13. `tauri.conf.json`

**Conflict**: Both changed multiple sections.

**Resolution**:

1. Keep offline-audio's identifier: `"com.readest-ooze"`
2. Keep offline-audio's removal of the `deep-link` section
3. Keep offline-audio's removal of `developmentTeam`
4. Accept main's CSP changes (removing chinese-fonts-cdn, adding
   storage.readest.com, adding `data:` to script-src)
5. Accept main's `webview-upgrade` config

---

### 14. `components/settings/MiscPanel.tsx`

Not a conflict file, but needs a new section added. Offline-audio added a raw
Tailwind "Custom TTS Endpoint" section. Per Decision #10, rewrite using main's
settings primitives.

**Add after the existing MiscPanel sections**:

```tsx
<SettingsSwitchRow
  title={_('Custom TTS Endpoint')}
  description={_('Use a custom TTS server for offline audio synthesis')}
  checked={settings.customTTSEndpoint?.enabled ?? false}
  onToggle={(checked) => {
    setSettings({
      customTTSEndpoint: {
        ...settings.customTTSEndpoint,
        enabled: checked,
      },
    });
  }}
/>;
{
  settings.customTTSEndpoint?.enabled && (
    <SettingsInput
      label={_('Endpoint URL')}
      value={settings.customTTSEndpoint?.endpoint ?? ''}
      placeholder='http://localhost:8000/tts'
      onChange={(value) => {
        setSettings({
          customTTSEndpoint: {
            ...settings.customTTSEndpoint,
            endpoint: value,
          },
        });
      }}
    />
  );
}
```

**Note**: Study how main's `MiscPanel.tsx` uses `setSettings` — it likely uses
a helper from `useSettingsStore`. Follow the existing pattern exactly (the code
above is pseudocode; adapt to actual primitives in use).

---

### 15. Submodules

**packages/foliate-js**, **packages/tauri**, **packages/tauri-plugins**

**Resolution**: Point all three submodules to their commits on `main`.

```bash
git checkout main -- packages/foliate-js packages/tauri packages/tauri-plugins
```

---

### 16. Files to copy directly from offline-audio (no conflicts, no changes needed)

These files were added on offline-audio and don't exist on main. They can be
copied as-is:

```
apps/readest-app/src/services/tts/OfflineAudioManager.ts
apps/readest-app/src/services/tts/OfflineAudioStorage.ts
apps/readest-app/src/services/tts/OfflineTTSClient.ts
apps/readest-app/src/services/tts/HttpTTSClient.ts
apps/readest-app/src/services/tts/FoliateTTSHelper.ts
apps/readest-app/src/services/tts/providers/TTSProvider.ts
apps/readest-app/src/services/tts/providers/EdgeTTSProvider.ts
apps/readest-app/src/services/tts/providers/HttpTTSProvider.ts
apps/readest-app/src/services/tts/utils.ts
apps/readest-app/src/services/tts/data/kokoroVoices.ts
apps/readest-app/src/app/reader/components/sidebar/OfflineAudioDownload.tsx
```

**Also copy**:

```
apps/readest-app/HTTP_TTS_SETUP.md
apps/readest-app/OFFLINE_AUDIO_IMPLEMENTATION.md
```

### 17. Files needing minor merges (non-conflicting but both branches touched)

- **`TTSClient.ts`** — offline-audio added `setContext?()` to the interface.
  Main didn't touch this file. Use offline-audio's version.
- **`TTS index.ts`** — offline-audio added `HttpTTSClient` and `OfflineTTSClient`
  exports. Main didn't touch this file. Use offline-audio's version.
- **`TTS types.ts`** — main added `TTSMediaMetadataMode`. Offline-audio didn't
  touch this file. Use main's version (no conflict).
- **`readerStore.ts`** — Both added different state. Use main's version and add
  offline-audio's `showOfflineAudioDialog`, `offlineAudioBookKey`, and
  `setShowOfflineAudioDownload` to both the interface and the store body.
  These were auto-merged; verify the merge result is correct.
- **`EdgeTTSClient.ts`** — Only changed on main (appService for Linux rate).
  Use main's version.
- **`NativeTTSClient.ts`** — Only changed on main. Use main's version.
- **`TTSBar.tsx`** — Only changed on main (removed unused React import). Use
  main's version.
- **`settings/LangPanel.tsx`** — Offline-audio added empty whitespace. Ignore.
  Use main's version.

---

## Implementation Steps (order)

1. Start from the `offline-audio` branch
2. Run the merge: `git merge main` (expect conflicts)
3. Resolve submodules first: `git checkout main -- packages/foliate-js packages/tauri packages/tauri-plugins`
4. Copy all unconflicted offline-audio new files (section 16)
5. Resolve each conflicting file per the instructions above, in this order:
   - Simple: `.env.local.example`, `tauri.conf.json`, `useLongPress.ts`
   - Constants/config: `constants.ts`, `settings.ts`, `appService.ts`
   - Component: `BookMenu.tsx`, `TTSPanel.tsx`, `TTSIcon.tsx`, `ReaderContent.tsx`
   - Core TTS: `TTSClient.ts`, `index.ts`, `readerStore.ts`
   - Critical: `TTSController.ts`, `useTTSControl.ts`, `TTSControl.tsx`
6. Add Custom TTS Endpoint to `MiscPanel.tsx` using primitives
7. `git add` all resolved files
8. Run type check: `pnpm lint` (which runs tsgo)
9. Run tests: `pnpm test`
10. Fix any type errors or test failures
11. Commit the merge

---

## Verification Checklist

After merge, verify:

- [ ] `pnpm lint` passes (type check)
- [ ] `pnpm test` passes
- [ ] TTSIcon shows the offline download bubble indicator
- [ ] Clicking the offline bubble opens the OfflineAudioDownload dialog
- [ ] BookMenu has "Offline Audio" menu item between Parallel Read and sync
- [ ] TTS play/stop/forward/backward works normally (online TTS not broken)
- [ ] Custom TTS Endpoint settings appear in MiscPanel with proper primitives
- [ ] No `NEXT_PUBLIC_ENABLE_HTTP_TTS` references remain
- [ ] Submodules point to main's commits

---

## Files NOT to modify

- Any Rust files in `src-tauri/` (not touched by either branch in conflicting ways)
- `next.config.mjs` (auto-merged, nothing TTS-related)
- `package.json` (auto-merged, nothing TTS-related)
- Any files outside `apps/readest-app/`
