# Download Refactor: Download Orphan Spine Sections

## Problem

EPUBs can have multiple spine items (XHTML files) under a single TOC entry. The TOC
entry's `href` points to the first spine item. When the paginator reaches the end of
that spine item, it auto-advances to the next spine item — even though there's no
separate TOC entry for it. The sidebar still shows the same chapter because
`TOCProgress` (in `packages/foliate-js/progress.js:30-33`) handles this at runtime:

```javascript
// When a spine section has no TOC entry, fall back to the previous one's mapping
if (grouped.has(id)) map.set(id, grouped.get(id));
else map.set(id, map.get(ids[i - 1]));
```

However, the offline audio download only processes TOC items. It never knows about
the orphan spine sections that belong to each TOC entry. This means playback works
for the first spine item but fails (falls back to online TTS) for subsequent ones.

### Example structure

```
TOC entry: "OEBPS/chapter-1.htm.html#start"
  ├── Spine section: "OEBPS/chapter-1.htm.html"   ← downloaded (100 chunks)
  └── Spine section: "OEBPS/chapter-2.htm.html"    ← NOT downloaded (orphan)
```

## Fix Strategy

In `OfflineAudioManager.downloadSections`, for each selected TOC item, also find and
download any consecutive spine sections that have no TOC entry. These are the
"orphan" sections that implicitly belong to the current TOC entry.

### Algorithm

```
for each TOC item in download selection:
  1. Split the TOC href to get the base section ID (before #)
  2. Find the spine section index for this base section ID
  3. Walk forward through spine sections starting at this index
  4. For each spine section:
     a. If it has a TOC entry → this is the next TOC boundary, stop
     b. If it has no TOC entry → it's an orphan belonging to this TOC item
     c. Download audio for it, storing with the section's clean id
```

## Files to Change

### 1. `apps/readest-app/src/services/tts/OfflineAudioManager.ts`

**Lines 323-438** — Refactor the download loop in `downloadSections()`.

Current flow:

```typescript
const allSections = sections; // TOCItem[]
for (const tocItem of allSections) {
    const { href } = tocItem;           // TOC href (may include fragment)
    await generateSSMLChunksForSection(bookDoc, href);  // resolves TOC href → one section
    await downloadSectionWithFoliateTTS(bookHash, href, ssmlChunks, ...);
}
```

New flow:

```typescript
// Step 1: Build a Set of section IDs that have TOC entries.
// We need this to know when to stop walking forward (don't include
// sections that belong to the NEXT TOC entry).
const tocSectionIds = new Set<string>();
for (const tocItem of sections) {
  const href = tocItem.href || '';
  const sectionId = href.split('#')[0] || href;
  if (sectionId) tocSectionIds.add(sectionId);
}

// Step 2: Expand each selected TOC item into its spine sections.
// Each TOC item maps to one primary spine section (the one matching its href).
// It may also "own" consecutive orphan sections (spine items with no TOC entry).
//
// We produce a "download plan": an ordered list of (tocItem, spineSection[]) pairs.
interface DownloadPlanEntry {
  tocItem: TOCItem;
  spineSections: string[]; // section IDs to download for this TOC item
}
const downloadPlan: DownloadPlanEntry[] = [];

for (const tocItem of sections) {
  const tocHref = tocItem.href || '';
  if (!tocHref) continue;

  const baseSectionId = tocHref.split('#')[0] || tocHref;

  // Find the spine section index matching this TOC item
  const startIndex = bookDoc.sections.findIndex((s: SectionItem) => s.id === baseSectionId);
  if (startIndex < 0) continue;

  // Collect this section and any orphan sections after it
  const spineIds: string[] = [];
  for (let i = startIndex; i < bookDoc.sections.length; i++) {
    const sectionId = bookDoc.sections[i]!.id;
    if (i > startIndex && tocSectionIds.has(sectionId)) {
      break; // next TOC entry starts here, stop
    }
    // Deduplicate: skip if already in another TOC item's plan
    if (spineIds.includes(sectionId)) continue;
    spineIds.push(sectionId);
  }

  downloadPlan.push({ tocItem, spineSections: spineIds });
}

// Step 3: Download each spine section.
// Progress now counts spine sections, not TOC items.
const totalSpineSections = downloadPlan.reduce((sum, entry) => sum + entry.spineSections.length, 0);
const progress: DownloadProgress = {
  bookHash,
  totalSections: totalSpineSections, // was: allSections.length
  downloadedSections: 0,
  failedSections: [],
  inProgress: true,
  sectionHrefs: downloadPlan.flatMap((e) => e.spineSections),
  startedAt: Date.now(),
};

// Count already downloaded spine sections for initial progress
for (const entry of downloadPlan) {
  for (const sectionId of entry.spineSections) {
    if (existingDownloads.has(sectionId)) {
      progress.downloadedSections++;
    }
  }
}

let sectionsCompletedCount = progress.downloadedSections;

for (const entry of downloadPlan) {
  if (abortController.signal.aborted) break;

  const { tocItem, spineSections: spineIds } = entry;
  const { label } = tocItem;

  for (const sectionId of spineIds) {
    if (abortController.signal.aborted) break;

    // Skip if already downloaded (check by section id)
    if (existingDownloads.has(sectionId)) continue;

    try {
      // Generate SSML from the spine section's document,
      // passing the section ID directly (no TOC fragment).
      const ssmlChunks = await generateSSMLChunksForSection(bookDoc, sectionId, granularity);

      if (ssmlChunks.length > 0) {
        // ... same dispatchEvent('section-download-start') ...

        // Store audio with the CLEAN section ID as the base href.
        // This ensures getSectionAudio() range queries match.
        // chunkHref will be: "sectionId#block-0", "sectionId#block-1", etc.
        await this.downloadSectionWithFoliateTTS(
          bookHash,
          sectionId, // <-- was: tocItem.href (with fragment)
          ssmlChunks,
          voiceId,
          lang,
          rate,
          pitch,
          granularity,
          targetLang,
          (downloaded, total) => {
            // ... same progress callback ...
            progress.downloadedSections = sectionsCompletedCount + fraction;
            // ...
          },
          abortController.signal,
        );
      }

      sectionsCompletedCount++;
      // ...
    } catch (error) {
      // ... same error handling, but use sectionId in failedSections ...
    }
  }
}
```

**Key points:**

- `generateSSMLChunksForSection(bookDoc, sectionId)` — `sectionId` is the clean
  spine section id (e.g., `"OEBPS/chapter-2.htm.html"`). `loadSectionDocument` will
  match it via the `href.includes(sectionHref)` check since `sectionId` contains
  itself. The SSML is generated from the correct document.
- `downloadSectionWithFoliateTTS(bookHash, sectionId, ...)` — `sectionId` becomes
  the base for chunk hrefs. `chunkHref = sectionId + "#block-" + blockIndex`.
  During playback, `getSectionAudio(bookHash, sectionId)` uses a range query on
  `[bookHash, sectionId]` to `[bookHash, sectionId + '\uffff']` and finds all blocks.
- `markSectionComplete(bookHash, sectionId, voiceId, chunkCount)` — stores
  completion with the clean section id. `getDownloadedVoiceForSection` strips
  fragments on both sides (line 419-434 of OfflineAudioStorage.ts), so it will find
  this completion when looking up the section's audio availability.
- `totalSections` and `sectionHrefs` in the `DownloadProgress` object now use spine
  section counts/ids, not TOC item counts/hrefs. This is correct because the UI
  dispatches progress events per-spine-section.

**Progress events:** The `download-progress` custom event's `href` field
(line 399-408) should use `sectionId` (the spine section being downloaded) so the
UI can highlight which section is currently downloading. The `label` field can
still use `tocItem.label || sectionId`.

### 2. `apps/readest-app/src/app/reader/components/sidebar/OfflineAudioDownload.tsx`

**Lines 178, 395, 428, 518-522, 541, 620** — Update all checks that compare
TOC hrefs against `downloadedHrefs`.

The problem: `downloadedHrefs` is populated from
`offlineAudioManager.getAllDownloadedSections()` which returns completion hrefs
from `COMPLETION_STORE`. After the refactor, these are **section IDs** (clean,
no fragment). But the TOC items have `href` with fragments (e.g.,
`"chapter-1.htm.html#start"`).

The UI checks like `downloadedHrefs.has(item.href || '')` will fail for TOC hrefs
with fragments because the stored completion uses only the base section id.

**Fix:** Create a helper function that checks if a TOC href is downloaded by
stripping its fragment and checking the base section id:

```typescript
// Add near the top of the component, after imports:
const isTocItemDownloaded = (downloadedHrefs: Set<string>, tocHref: string): boolean => {
  if (!tocHref) return false;
  if (downloadedHrefs.has(tocHref)) return true;
  // Also check the base section id (strip fragment after #)
  const baseHref = tocHref.split('#')[0] || tocHref;
  return tocHref !== baseHref && downloadedHrefs.has(baseHref);
};
```

Then replace all instances of `downloadedHrefs.has(href)` with
`isTocItemDownloaded(downloadedHrefs, href)`:

| Line | Current Code                                | Replace With                                                 |
| ---- | ------------------------------------------- | ------------------------------------------------------------ |
| 395  | `!downloadedHrefs.has(x.item.href \|\| '')` | `!isTocItemDownloaded(downloadedHrefs, x.item.href \|\| '')` |
| 428  | `!downloadedHrefs.has(x.item.href \|\| '')` | `!isTocItemDownloaded(downloadedHrefs, x.item.href \|\| '')` |
| 482  | `downloadedHrefs.has(href)`                 | `isTocItemDownloaded(downloadedHrefs, href)`                 |
| 518  | `!downloadedHrefs.has(h)`                   | `!isTocItemDownloaded(downloadedHrefs, h)`                   |
| 519  | `downloadedHrefs.has(h)`                    | `isTocItemDownloaded(downloadedHrefs, h)`                    |
| 521  | `!downloadedHrefs.has(h)`                   | `!isTocItemDownloaded(downloadedHrefs, h)`                   |
| 522  | `downloadedHrefs.has(h)`                    | `isTocItemDownloaded(downloadedHrefs, h)`                    |
| 541  | `downloadedHrefs.size`                      | unchanged (size of unique section ids is still meaningful)   |
| 620  | `downloadedHrefs.has(item.href \|\| '')`    | `isTocItemDownloaded(downloadedHrefs, item.href \|\| '')`    |

### 3. No changes needed in these files

- **`OfflineAudioStorage.ts`** — `getDownloadedVoiceForSection` already strips
  fragments on both sides (line 419-434). `getSectionAudio` uses a range query
  starting at the base href. `saveAudio` stores chunk hrefs as-is. All of these
  work correctly with clean section IDs.
- **`OfflineTTSClient.ts`** — `hasOfflineAudio`, `findAudioChunkByContent`, and
  `setContext` all use the section href from TTSController. The previous fix
  (in `#initTTSForSection`) already sets `section.id` (clean section id) as the
  context. No changes needed here.
- **`TTSController.ts`** — The section transition fix from the previous change
  already handles context updates using `section.id`. No changes needed.
- **`FoliateTTSHelper.ts`** — `loadSectionDocument` does fuzzy matching with
  `includes`, which works for clean section IDs (they match themselves).
  No changes needed.

## Edge Cases

### Multiple TOC items mapping to the same spine section

Two TOC entries (e.g., "Chapter 1 Part A" and "Chapter 1 Part B") might both have
fragments pointing to the same spine section (e.g., `chapter1.xhtml#partA` and
`chapter1.xhtml#partB`). In this case:

- `tocSectionIds` has only `"chapter1.xhtml"` (since we strip fragments)
- Both TOC items map to the same `startIndex`
- The first TOC item's plan includes `"chapter1.xhtml"` and any orphans after it
- The second TOC item's plan also tries to include `"chapter1.xhtml"` but sees it
  already has entries → skips (deduplication)
- The second TOC item's plan might be empty → skip processing it

This is correct: the audio only needs to be downloaded once for the shared spine
section, and any subsequent TOC items that map to it are effectively already
downloaded.

### TOC item without a matching spine section

If `bookDoc.sections.findIndex(s => s.id === baseSectionId)` returns -1, the
code should `continue` to the next TOC item (already handled in the plan).

### Aborted download mid-orphan-section

The abort check is already at the top of each loop iteration. If the download is
cancelled while processing an orphan section, the download exits gracefully.

### Previously downloaded audio with old-style hrefs

If the user already downloaded audio before this refactor (with TOC-fragment hrefs
like `"chapter.xhtml#start#block-0"`), those chunks will still be stored. The
range query in `getSectionAudio` will still find them (they start with the same
base href). The new chunks (stored with clean section ids like
`"chapter.xhtml#block-0"`) will coexist. The `hasOfflineAudio` check will find
both old and new chunks.

**Recommendation:** After implementing this refactor, existing users should delete
and re-download their offline audio to clean up old double-fragmented hrefs.
This is not strictly required for correctness but keeps the storage tidy.

### Verification checklist

After implementation, verify:

1. Selecting a chapter that spans multiple spine sections in the download UI
   and clicking Download creates audio for ALL spine sections
2. `OfflineTTSClient.hasOfflineAudio()` returns `true` for orphan spine sections
3. Playback transitions seamlessly from the last block of section N to the first
   block of section N+1 without falling back to online TTS
4. The download progress bar counts the correct total number of spine sections
5. Previously downloaded sections are correctly marked as "already downloaded"
   in the UI checkbox list
6. Delete functionality still works for downloaded sections
