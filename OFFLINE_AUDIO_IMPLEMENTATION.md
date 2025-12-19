# Offline Audio Download Feature - Implementation Summary

## Overview
I've implemented a complete offline audio download system for the Readest app that allows users to download Edge TTS audio for entire books and listen offline.

## Components Created

### 1. Storage Layer (`OfflineAudioStorage.ts`)
- **IndexedDB-based storage** for offline audio with two object stores:
  - `audioRecords`: Stores audio blobs with metadata (bookHash, href, voiceId, rate, pitch, text, SSML)
  - `downloadProgress`: Tracks download progress per book
- **Key features**:
  - Save/retrieve audio by composite key (bookHash:href:voiceId)
  - Query downloaded hrefs for a book
  - Track download progress with error handling
  - Get storage size statistics
  - Delete book audio and progress

### 2. Download Manager (`OfflineAudioManager.ts`)
- **Orchestrates the download process**:
  - Flattens book TOC to get all chapters/sections
  - Extracts text from each section using BookDoc
  - Generates audio using Edge TTS API
  - Stores audio blobs in IndexedDB
  - Tracks progress with callbacks
- **Event-driven architecture**:
  - Emits `download-progress`, `download-complete`, `download-error`, `download-deleted` events
  - Supports cancellation via AbortController
  - Handles failed sections gracefully
- **Features**:
  - Resume partial downloads
  - Check if sections are downloaded
  - Get total storage used
  - Delete book downloads

### 4. UI Components

#### Download Dialog (`OfflineAudioDownload.tsx`)
- **Modal dialog** with:
  - Download button to start downloading entire book
  - **Progress bar** showing download status (X/Y sections, percentage)
  - **Cancel button** during active download
  - **Success indicator** when complete
  - **Error display** with retry option
  - **Storage usage** information
  - **Delete button** to remove downloaded audio
  - Resume capability for partial downloads
- **States handled**:
  - Not downloaded
  - Downloading (with progress)
  - Partially downloaded (can resume)
  - Fully downloaded
  - Error states

#### Book Menu Integration (`BookMenu.tsx`)
- Added **"Offline Audio"** menu item with download icon
- Opens download dialog when clicked
- Positioned logically in the menu structure

#### TOC Indicators (`TOCItem.tsx` & `TOCView.tsx`)
- **Checkmark icons** (MdCheckCircle) next to downloaded chapters in Table of Contents
- Automatically updates when:
  - Download progresses
  - Download completes
  - Downloads are deleted
- Uses event listeners to stay in sync with download status

## How It Works

### Download Flow
1. User clicks "Offline Audio" in Book Menu
2. Dialog shows current download status (if any)
3. User clicks "Download for Offline Listening"
4. System:
   - Initializes download manager
   - Flattens TOC to get all chapters
   - For each chapter:
     - Extracts text from section
     - Generates SSML marks
     - Downloads audio via Edge TTS
     - Stores in IndexedDB
     - Updates progress
   - Shows real-time progress bar
5. User can cancel anytime
6. On completion, TOC shows checkmarks

### Data Storage
```
IndexedDB: ReadestOfflineAudio
├── audioRecords
│   └── id: "${bookHash}:${href}:${voiceId}"
│       ├── bookHash
│       ├── href
│       ├── voiceId
│       ├── audioBlob (Blob)
│       ├── rate
│       ├── pitch
│       ├── text
│       ├── ssml
│       ├── downloadedAt
│       └── size
└── downloadProgress
    └── bookHash
        ├── totalSections
        ├── downloadedSections
        ├── failedSections[]
        ├── inProgress
        ├── startedAt
        ├── completedAt
        └── lastError
```

## Recent Updates (December 2025)

### TTS Provider Refactoring
- **Abstracted TTS provider interface**: Created `TTSProvider` interface to decouple audio generation from OfflineAudioManager
- **EdgeTTSProvider implementation**: Wrapped EdgeSpeechTTS in a provider class for better modularity
- **Provider switching**: OfflineAudioManager can now work with different TTS providers, enabling future support for custom TTS engines

### Playback Speed Support
- **Dynamic playback rate**: OfflineTTSClient now supports adjusting playback speed during playback
- **Fixed timing calculations**: Corrected real time vs audio time conversion for accurate mark highlighting
- **No crashes on speed change**: Playback speed can be changed without restarting audio

### Background Audio Support
- **Media session integration**: Offline TTS properly integrates with system media controls
- **Lockscreen controls**: Play/pause/next/previous work from lockscreen and notification center
- **iOS background audio**: Background audio enabled via `invokeUseBackgroundAudio()` on iOS

## Future Enhancements

### Near-term
1. ~~**Implement offline playback** in OfflineTTSClient~~ ✅ **Completed**
2. ~~**Rate/pitch settings** for downloaded audio~~ ✅ **Rate support added**
3. **Voice selection** in download dialog (currently uses default)
4. **Target language filter** support
5. **Smart section mapping** (currently simplified)

### Mid-term
1. **Background downloads** using Service Workers
2. **Selective chapter downloads** (not just entire book)
3. **Download queue** for multiple books
4. **Storage management** UI (see all downloads, manage space)
5. **Download over WiFi only** option

### Long-term
1. **Sync downloads** across devices
2. **Pre-download popular books**
3. **Smart caching** based on reading patterns
4. **Offline-first architecture**

## Technical Notes

- **Voice ID**: Currently hardcoded to 'en-US-AriaNeural' - should be made configurable
- **Section text extraction**: Uses BookDoc.sections[].createDocument() - may need optimization for large books
- **SSML processing**: Reuses existing parseSSMLMarks utility
- **Storage limits**: Browser IndexedDB typically allows ~50% of disk space
- **Error handling**: Graceful degradation with failed section tracking
- **Playback speed**: Implemented using AudioBufferSourceNode.playbackRate (1.0 = normal, 2.0 = 2x speed)
- **Background audio**: Uses native media session APIs for lockscreen/notification controls
- **Provider pattern**: TTS audio generation is now abstracted, allowing for multiple TTS engines

## Files Modified/Created

### Created
- `apps/readest-app/src/services/tts/OfflineAudioStorage.ts` (267 lines)
- `apps/readest-app/src/services/tts/OfflineAudioManager.ts` (293 lines, refactored for provider pattern)
- `apps/readest-app/src/services/tts/OfflineTTSClient.ts` (formerly OfflineEdgeTTSClient, 520+ lines)
- `apps/readest-app/src/services/tts/providers/TTSProvider.ts` (interface definition)
- `apps/readest-app/src/services/tts/providers/EdgeTTSProvider.ts` (EdgeTTS implementation)
- `apps/readest-app/src/services/tts/providers/index.ts` (exports)
- `apps/readest-app/src/app/reader/components/sidebar/OfflineAudioDownload.tsx` (249 lines)

### Modified
- `apps/readest-app/src/app/reader/components/sidebar/BookMenu.tsx`
  - Added import for OfflineAudioDownload
  - Added state for dialog visibility
  - Added menu item with icon
  - Added dialog render with overlay
- `apps/readest-app/src/app/reader/components/sidebar/TOCItem.tsx`
  - Added MdCheckCircle icon import
  - Added isDownloaded prop
  - Added checkmark display
  - Updated interfaces for downloadedHrefs
- `apps/readest-app/src/app/reader/components/sidebar/TOCView.tsx`
  - Added offlineAudioManager import
  - Added downloadedHrefs state
  - Added effect to load and sync downloaded hrefs
  - Added event listeners for download updates
  - Passed downloadedHrefs to child components

## Testing Recommendations

1. **Download full book** - verify progress tracking
2. **Cancel during download** - verify cleanup
3. **Resume partial download** - verify skips existing
4. **Delete downloaded audio** - verify storage cleanup
5. **TOC checkmarks** - verify appear/disappear correctly
6. **Multiple books** - verify isolation
7. **Large books** - verify performance
8. **Offline mode** - verify storage persists
9. **Storage limits** - verify error handling
10. **Concurrent operations** - verify state consistency
