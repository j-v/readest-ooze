/**
 * OfflineAudioManager - Orchestrates downloading and managing offline TTS audio
 * Uses Foliate TTS for SSML generation to ensure parity with online TTS highlighting.
 */

import { TOCItem, BookDoc, SectionItem } from '@/libs/document';
import { offlineAudioStorage, DownloadProgress, MarkTimingInfo } from './OfflineAudioStorage';
import TTSProvider from './providers/TTSProvider';
import EdgeTTSProvider from './providers/EdgeTTSProvider';
import HttpTTSProvider from './providers/HttpTTSProvider';
import { EdgeSpeechTTS } from '@/libs/edgeTTS';
import { KOKORO_VOICES } from './data/kokoroVoices';
import { TTSUtils } from './TTSUtils';
import { parseSSMLMarks, filterSSMLWithLang } from '@/utils/ssml';
import { getAudioDuration, simpleHash } from './utils';
import { generateSSMLChunksForSection } from './FoliateTTSHelper';
import { TTSGranularity, TTSVoicesGroup } from './types';
import { getUserLocale } from '@/utils/misc';
import { useSettingsStore } from '@/store/settingsStore';

export interface DownloadSectionsOptions {
  bookHash: string;
  bookDoc: BookDoc;
  sections: TOCItem[];
  voiceId: string;
  rate: number;
  pitch: number;
  primaryLang: string;
  targetLang?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadStatus {
  inProgress: boolean;
  progress: DownloadProgress | null;
  downloadedHrefs: Set<string>;
}

class OfflineAudioManager extends EventTarget {
  private provider: TTSProvider; // Default/current provider
  private edgeProvider: EdgeTTSProvider;
  private httpProvider: HttpTTSProvider;
  private activeDownloads = new Map<string, AbortController>();
  private downloadWakeLock: WakeLockSentinel | null = null;

  constructor() {
    super();
    this.edgeProvider = new EdgeTTSProvider();

    // Initialize with current settings
    const endpoint = useSettingsStore.getState().settings.customTTSEndpoint?.endpoint || '';
    this.httpProvider = new HttpTTSProvider({
      endpoint,
      timeoutMs: 30000,
    });
    this.provider = this.edgeProvider;

    let currentEndpoint = endpoint;
    // Subscribe to settings changes to update provider
    useSettingsStore.subscribe((state) => {
      const newEndpoint = state.settings.customTTSEndpoint.endpoint;

      if (currentEndpoint !== newEndpoint) {
        currentEndpoint = newEndpoint;
        this.httpProvider = new HttpTTSProvider({
          endpoint: newEndpoint,
          timeoutMs: 30000,
        });
      }
    });
  }

  async init(): Promise<void> {
    await offlineAudioStorage.init();
    if (this.edgeProvider.init) await this.edgeProvider.init();
    if (this.httpProvider.init) await this.httpProvider.init();
  }

  /**
   * Preprocess SSML to match TTSController's preprocessing logic.
   * This ensures stored audio matches what TTSController will request during playback.
   */
  private preprocessSSML(ssml: string, targetLang?: string): string {
    // Apply same transformations as TTSController#preprocessSSML
    // Note: whitespace normalization is done by normalizeWhitespace() after parseSSMLMarks()
    ssml = ssml
      .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
      .replace(/[\u2013\u2014]/g, ',')
      .replace('<break/>', ' ')
      .replace(/\.{3,}/g, '   ')
      .replace(/\u2026\u2026/g, '  ')
      .replace(/\*/g, ' ')
      .replace(/\u00b7/g, ' ');

    if (targetLang) {
      ssml = filterSSMLWithLang(ssml, targetLang);
    }
    return ssml;
  }

  /**
   * Normalize whitespace in plain text to ensure consistent matching.
   * Collapses multiple spaces and normalizes line endings.
   */
  private normalizeWhitespace(text: string): string {
    return text
      .replace(/\s+/g, ' ') // Collapse multiple whitespace to single space
      .trim();
  }

  /**
   * Convert a blob to base64 string for storage in IndexedDB
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          // Remove the data:audio/mpeg;base64, prefix if present
          const base64 = result.includes(',') ? result.split(',')[1] || result : result;
          resolve(base64);
        } else {
          reject(new Error('FileReader did not return string'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Download audio for a section using Foliate TTS-generated SSML chunks.
   * Each SSML chunk corresponds to a block/paragraph in the document.
   */
  private async downloadSectionWithFoliateTTS(
    bookHash: string,
    href: string,
    ssmlChunks: Array<{ ssml: string; blockIndex: number }>,
    voiceId: string,
    lang: string,
    rate: number,
    pitch: number,
    granularity: TTSGranularity,
    targetLang?: string,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
    skipCompletion?: boolean,
  ): Promise<void> {
    const allMarkMetadata: MarkTimingInfo[] = [];
    let cumulativeAudioOffset = 0;
    let totalPlainText = '';

    for (let chunkIndex = 0; chunkIndex < ssmlChunks.length; chunkIndex++) {
      if (signal?.aborted) {
        throw new Error('Download cancelled');
      }
      const chunk = ssmlChunks[chunkIndex]!;
      const { ssml: rawSSML, blockIndex } = chunk;

      // Preprocess SSML to match TTSController's preprocessing
      const ssml = this.preprocessSSML(rawSSML, targetLang);

      // Parse SSML to get marks and plain text
      const { plainText: rawPlainText, marks } = parseSSMLMarks(ssml, lang);

      // Normalize whitespace for consistent matching
      const plainText = this.normalizeWhitespace(rawPlainText);

      if (!plainText || marks.length === 0) {
        console.log(`[OfflineAudioManager] Skipping empty chunk ${chunkIndex}`);
        continue;
      }

      totalPlainText += plainText;

      console.log(`[OfflineAudioManager] Processing chunk ${chunkIndex} (block ${blockIndex}):`, {
        marksCount: marks.length,
        textLength: plainText.length,
        firstMark: marks[0]?.name,
      });

      try {
        // Select appropriate provider based on voice ID
        let currentProvider = this.provider;
        const isKokoro = KOKORO_VOICES.some((v) => v.id === voiceId);
        if (isKokoro) {
          currentProvider = this.httpProvider;
        } else {
          currentProvider = this.edgeProvider;
        }

        // Generate audio for the entire chunk's plain text via provider
        const bufferOrBlob = await currentProvider.synthesize(plainText, {
          lang,
          voice: voiceId,
          rate,
          pitch,
          granularity,
          targetLang,
        });

        const arrayBuffer =
          bufferOrBlob instanceof Blob ? await bufferOrBlob.arrayBuffer() : bufferOrBlob;
        const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });

        // Convert to base64 for IndexedDB storage (iOS compatibility)
        const base64Audio = await this.blobToBase64(audioBlob);

        // Get audio duration
        const chunkDuration = await getAudioDuration(audioBlob);

        // Create timing metadata for each mark in this chunk
        // Distribute duration proportionally across marks based on text length
        const totalChars = marks.reduce((sum, m) => sum + m.text.length, 0);
        let markOffset = cumulativeAudioOffset;

        for (const mark of marks) {
          const markDuration = (mark.text.length / Math.max(totalChars, 1)) * chunkDuration;
          allMarkMetadata.push({
            name: mark.name,
            text: mark.text,
            language: mark.language,
            offset: mark.offset,
            audioOffset: markOffset,
            duration: markDuration,
          });
          markOffset += markDuration;
        }

        cumulativeAudioOffset += chunkDuration;

        // Store audio chunk with unique href per block
        const chunkHref = `${href}#block-${blockIndex}`;
        // console.log('[OfflineAudioManager] Saving audio chunk:', {
        //   bookHash,
        //   href: chunkHref,
        //   voiceId,
        // });

        await offlineAudioStorage.saveAudio({
          bookHash,
          href: chunkHref,
          voiceId,
          audioData: base64Audio,
          durationMs: chunkDuration,
          rate,
          pitch,
          text: plainText,
          ssml: ssml,
          size: audioBlob.size,
          downloadedAt: Date.now(),
        });

        onProgress?.(chunkIndex + 1, ssmlChunks.length);
      } catch (error) {
        console.error(`Error downloading audio for chunk ${chunkIndex}:`, error);
        throw error;
      }
    }

    // Generate content hash for validation
    const contentHash = simpleHash(totalPlainText);

    // Save mark metadata for synchronization
    await offlineAudioStorage.saveMarkMetadata({
      bookHash,
      href,
      voiceId,
      contentHash,
      granularity,
      language: lang,
      marks: allMarkMetadata,
      totalDuration: cumulativeAudioOffset,
      createdAt: Date.now(),
    });

    // Mark section as complete (skip for boundary sections — the completion
    // will be added when the owning TOC entry is explicitly downloaded)
    if (!skipCompletion) {
      await offlineAudioStorage.markSectionComplete(bookHash, href, voiceId, ssmlChunks.length);
    }
  }

  /**
   * Download audio for entire book
   */
  /**
   * Download audio for a subset of sections
   */
  async downloadSections(options: DownloadSectionsOptions): Promise<void> {
    const {
      bookHash,
      bookDoc,
      sections,
      voiceId,
      rate,
      pitch,
      primaryLang,
      targetLang,
      onProgress,
      signal,
    } = options;

    // Create abort controller for this batch if not provided
    // (Note: if called from downloadBook, we might want to share the controller or use the signal)
    // We'll use the signal if provided, otherwise manage our own.
    // However, to track in activeDownloads, we need a controller.
    // If this is the primary operation for the book, we set it.
    let abortController = this.activeDownloads.get(bookHash);

    if (!abortController) {
      abortController = new AbortController();
      this.activeDownloads.set(bookHash, abortController);
    }

    // If an external signal was passed, link it to the controller
    if (signal) {
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController?.abort());
      }
    }

    try {
      // Prevent screen sleep during download
      if ('wakeLock' in navigator) {
        try {
          this.downloadWakeLock = await navigator.wakeLock.request('screen');
          this.downloadWakeLock?.addEventListener('release', () => {
            this.downloadWakeLock = null;
          });
        } catch {
          // wake lock not available, proceed without it
        }
      }

      // Step 1: Build a Set of section IDs that have TOC entries (from ALL TOC items,
      // not just the selected ones). We need this to know when to stop walking forward
      // — sections that belong to the NEXT TOC entry must act as boundaries even if
      // that TOC item wasn't selected for download.
      const tocSectionIds = new Set<string>();
      const tocFragmentBoundaries = new Set<string>();
      const collectTocSectionIds = (items: TOCItem[]) => {
        for (const item of items) {
          const href = item.href || '';
          const [baseId, fragment] = href.split('#');
          const sectionId = baseId || href;
          if (sectionId) {
            tocSectionIds.add(sectionId);
            if (fragment) tocFragmentBoundaries.add(sectionId);
          }
          if (item.subitems) collectTocSectionIds(item.subitems);
        }
      };
      if (bookDoc.toc) collectTocSectionIds(bookDoc.toc);

      // Log all spine sections and TOC entry boundaries for debugging
      console.log(
        '[OfflineAudioManager] All spine sections:',
        bookDoc.sections.map((s, i) => ({
          index: i,
          id: s.id,
          hasTocEntry: tocSectionIds.has(s.id),
        })),
      );
      console.log('[OfflineAudioManager] TOC section IDs (boundaries):', {
        all: Array.from(tocSectionIds),
        withFragment: Array.from(tocFragmentBoundaries),
      });

      // Step 2: Expand each selected TOC item into its spine sections.
      // Each TOC item maps to one primary spine section (the one matching its href).
      // It may also "own" consecutive orphan sections (spine items with no TOC entry).
      //
      // We produce a "download plan": an ordered list of (tocItem, spineSection[]) pairs.
      // Each spine section is tagged with isBoundary — true when the section has its own TOC
      // entry (next chapter boundary). Boundary sections are downloaded for audio availability
      // but NOT marked complete; the completion is added when the owning TOC entry is downloaded.
      interface PlanSection {
        id: string;
        isBoundary: boolean;
      }
      const downloadPlan: Array<{
        tocItem: TOCItem;
        spineSections: PlanSection[];
      }> = [];

      for (const tocItem of sections) {
        const tocHref = tocItem.href || '';
        if (!tocHref) continue;

        const baseSectionId = tocHref.split('#')[0] || tocHref;

        // Find the spine section index matching this TOC item
        const startIndex = bookDoc.sections.findIndex((s: SectionItem) => s.id === baseSectionId);
        if (startIndex < 0) {
          console.log('[OfflineAudioManager] TOC item not found in spine sections:', {
            tocLabel: tocItem.label,
            tocHref,
            baseSectionId,
          });
          continue;
        }

        console.log('[OfflineAudioManager] Walking forward from spine section:', {
          tocLabel: tocItem.label,
          tocHref,
          baseSectionId,
          startIndex,
        });

        // Collect this section and any orphan sections after it.
        // When we encounter the next TOC entry's spine section:
        //   - If its TOC href has a fragment (e.g. h-4.xhtml#part3), the
        //     section overlaps both chapters. Include it as a boundary
        //     (download audio, skip completion marker).
        //   - If its TOC href has no fragment (e.g. h-4.xhtml), the next
        //     chapter starts cleanly at the top — no overlap. Skip it.
        const spineIds: PlanSection[] = [];
        for (let i = startIndex; i < bookDoc.sections.length; i++) {
          const sectionId = bookDoc.sections[i]!.id;
          const isOwnSectionBoundary = i > startIndex && tocSectionIds.has(sectionId);
          const isOverlapBoundary = isOwnSectionBoundary && tocFragmentBoundaries.has(sectionId);

          if (isOwnSectionBoundary && !isOverlapBoundary) {
            console.log('[OfflineAudioManager] Spine section walk:', {
              i,
              sectionId,
              action: 'BREAK — clean boundary, no overlap',
            });
            break;
          }
          spineIds.push({
            id: sectionId,
            isBoundary: isOverlapBoundary,
          });
          console.log(
            '[OfflineAudioManager] Spine section walk:',
            isOverlapBoundary
              ? { i, sectionId, action: 'include and BREAK — overlapping boundary' }
              : { i, sectionId, action: 'include' },
          );
          if (isOverlapBoundary) break;
        }

        downloadPlan.push({ tocItem, spineSections: spineIds });
      }

      console.log('[OfflineAudioManager] Download plan:', {
        tocItemCount: sections.length,
        totalSpineSections: downloadPlan.reduce((s, e) => s + e.spineSections.length, 0),
        plan: downloadPlan.map((e) => ({
          tocLabel: e.tocItem.label,
          tocHref: e.tocItem.href,
          spineSections: e.spineSections.map((s) => ({
            id: s.id,
            isBoundary: s.isBoundary,
          })),
        })),
      });

      // Check existing downloads — combine COMPLETION_STORE markers with
      // AUDIO_STORE chunks (boundary sections have audio but no marker).
      const existingDownloads = await offlineAudioStorage.getAllSectionIdsWithAudio(bookHash);

      // Initialize progress
      // totalSections now counts spine sections (including orphans),
      // but sectionHrefs keeps TOC hrefs for selection restoration.
      const totalSpineSections = downloadPlan.reduce(
        (sum, entry) => sum + entry.spineSections.length,
        0,
      );
      const progress: DownloadProgress = {
        bookHash,
        totalSections: totalSpineSections,
        downloadedSections: 0,
        failedSections: [],
        inProgress: true,
        sectionHrefs: sections.map((s) => s.href || '').filter(Boolean),
        startedAt: Date.now(),
      };

      // Count already downloaded spine sections for initial progress
      for (const entry of downloadPlan) {
        for (const { id: sectionId } of entry.spineSections) {
          if (existingDownloads.has(sectionId)) {
            progress.downloadedSections++;
          }
        }
      }

      await offlineAudioStorage.saveProgress(progress);
      onProgress?.(progress);

      let sectionsCompletedCount = progress.downloadedSections;

      // Download each spine section across all TOC items' plans
      for (const entry of downloadPlan) {
        if (abortController.signal.aborted) {
          break;
        }

        const { tocItem, spineSections: spineIds } = entry;
        const { label } = tocItem;

        for (const { id: sectionId, isBoundary } of spineIds) {
          if (abortController.signal.aborted) {
            break;
          }

          // Skip if already downloaded
          if (existingDownloads.has(sectionId)) {
            // Audio exists but completion marker may be missing (e.g. section
            // was first downloaded as a boundary for another TOC entry). If
            // this is now an owned section, add the completion marker.
            if (!isBoundary) {
              await offlineAudioStorage.markSectionComplete(bookHash, sectionId, voiceId, 0);
            }
            continue;
          }

          try {
            const lang = targetLang || primaryLang;
            const granularity: TTSGranularity = 'sentence';

            // Generate SSML from the spine section's document using the clean section ID
            const ssmlChunks = await generateSSMLChunksForSection(bookDoc, sectionId, granularity);

            if (ssmlChunks.length > 0) {
              console.log('[OfflineAudioManager] Downloading section', {
                tocLabel: label,
                tocHref: tocItem.href,
                sectionId,
                isBoundary,
                spineSectionsInPlan: spineIds.map((s) => s.id),
                totalSectionsInBook: bookDoc.sections.length,
                voiceId,
                lang,
              });

              this.dispatchEvent(
                new CustomEvent('section-download-start', {
                  detail: { bookHash, href: sectionId },
                }),
              );

              await this.downloadSectionWithFoliateTTS(
                bookHash,
                sectionId,
                ssmlChunks,
                voiceId,
                lang,
                rate,
                pitch,
                granularity,
                targetLang,
                (downloaded, total) => {
                  if (abortController.signal.aborted) return;
                  const fraction = total > 0 ? downloaded / total : 0;
                  progress.downloadedSections = sectionsCompletedCount + fraction;
                  this.dispatchEvent(
                    new CustomEvent('download-progress', {
                      detail: {
                        bookHash,
                        current: progress.downloadedSections,
                        total: totalSpineSections,
                        href: tocItem.href || sectionId,
                        label: label || sectionId,
                      },
                    }),
                  );
                  onProgress?.(progress);
                },
                abortController.signal,
                isBoundary, // skipCompletion — boundary sections don't get marked complete
              );
            }

            sectionsCompletedCount++;
            progress.downloadedSections = sectionsCompletedCount;
            existingDownloads.add(sectionId);
            await offlineAudioStorage.saveProgress(progress);
            onProgress?.(progress);

            // Dispatch section complete event only for owned sections
            // (boundary sections belong to a different TOC entry — don't
            // let the UI prematurely show the next chapter as downloaded)
            if (!isBoundary) {
              this.dispatchEvent(
                new CustomEvent('section-download-complete', {
                  detail: { bookHash, href: sectionId },
                }),
              );
            }

            this.dispatchEvent(
              new CustomEvent('download-progress', {
                detail: {
                  bookHash,
                  current: progress.downloadedSections,
                  total: totalSpineSections,
                  href: tocItem.href || sectionId,
                  label: label || sectionId,
                },
              }),
            );
          } catch (error) {
            if (
              abortController.signal.aborted ||
              (error instanceof Error && error.message === 'Download cancelled')
            ) {
              throw error;
            }

            console.error('Error downloading section:', sectionId, error);
            this.dispatchEvent(
              new CustomEvent('section-download-error', {
                detail: {
                  bookHash,
                  href: sectionId,
                  error: error instanceof Error ? error.message : String(error),
                },
              }),
            );
            progress.failedSections.push(sectionId);
            progress.lastError = error instanceof Error ? error.message : String(error);
            await offlineAudioStorage.saveProgress(progress);
            onProgress?.(progress);
          }
        }
      }

      // Mark as complete if we finished (and weren't aborted)
      if (!abortController.signal.aborted) {
        progress.inProgress = false;
        progress.completedAt = Date.now();
        await offlineAudioStorage.saveProgress(progress);
        onProgress?.(progress);

        this.dispatchEvent(
          new CustomEvent('download-complete', {
            detail: { bookHash, progress },
          }),
        );
      }
    } catch (error) {
      // Handle cancellation or errors
      if (
        abortController?.signal.aborted ||
        (error instanceof Error && error.message === 'Download cancelled')
      ) {
        // Graceful exit for cancellation
        // We ensure inProgress is false
        const p = await offlineAudioStorage.getProgress(bookHash);
        if (p) {
          p.inProgress = false;
          await offlineAudioStorage.saveProgress(p);
          onProgress?.(p);
        }
        // FALLTHROUGH: we still want to dispatch download-error so UI cleans up
      }

      const progress = await offlineAudioStorage.getProgress(bookHash);
      if (progress) {
        progress.inProgress = false;
        progress.lastError = error instanceof Error ? error.message : String(error);
        await offlineAudioStorage.saveProgress(progress);
        onProgress?.(progress);
      }

      this.dispatchEvent(
        new CustomEvent('download-error', {
          detail: {
            bookHash,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );

      throw error;
    } finally {
      if (this.downloadWakeLock) {
        try {
          await this.downloadWakeLock.release();
        } catch {
          // ignore release errors
        }
        this.downloadWakeLock = null;
      }

      // Cleanup only if we created it? Or if we finished?
      // Since we set it in activeDownloads, we should clean it up.
      // But only if we are the one who finished it.
      // If we are just a helper, maybe not?
      // But we are "downloadSections" now.
      if (this.activeDownloads.get(bookHash) === abortController) {
        this.activeDownloads.delete(bookHash);
      }
    }
  }

  /**
   * Cancel active download
   */
  cancelDownload(bookHash: string): void {
    const controller = this.activeDownloads.get(bookHash);
    if (controller) {
      controller.abort();
      this.activeDownloads.delete(bookHash);
    }
  }

  /**
   * Get download status for a book
   */
  async getStatus(bookHash: string, voiceId: string): Promise<DownloadStatus> {
    const progress = await offlineAudioStorage.getProgress(bookHash);
    const downloadedHrefs = await offlineAudioStorage.getCompletedSections(bookHash, voiceId);

    return {
      inProgress: this.activeDownloads.has(bookHash),
      progress,
      downloadedHrefs,
    };
  }

  /**
   * Delete all downloaded audio for a book
   */
  async deleteBook(bookHash: string): Promise<void> {
    this.cancelDownload(bookHash);
    await offlineAudioStorage.deleteBookAudio(bookHash);
    await offlineAudioStorage.deleteProgress(bookHash);

    this.dispatchEvent(
      new CustomEvent('download-deleted', {
        detail: { bookHash },
      }),
    );
  }

  /**
   * Delete downloaded audio for a single section
   */
  async deleteSections(bookHash: string, hrefs: string[]): Promise<void> {
    for (const href of hrefs) {
      // We don't know the exact voice ID here easily without querying,
      // but deleteAudioForSection might accept wildcard or we find it.
      const voiceId = await offlineAudioStorage.getDownloadedVoiceForSection(bookHash, href);
      if (voiceId) {
        await this.deleteSingleSection(bookHash, href, voiceId);
      }
    }
  }

  /**
   * Delete downloaded audio for a single section
   */
  async deleteSingleSection(bookHash: string, href: string, voiceId: string): Promise<void> {
    // Strip fragment — completions and chunk hrefs are stored with clean section IDs
    const sectionId = href.split('#')[0] || href;

    // Delete all chunks efficiently using range query
    await offlineAudioStorage.deleteAudioForSection(bookHash, sectionId, voiceId);

    // Delete completion status
    await offlineAudioStorage.deleteSectionCompletion(bookHash, sectionId, voiceId);

    this.dispatchEvent(
      new CustomEvent('section-download-deleted', {
        detail: { bookHash, href: sectionId },
      }),
    );
  }

  /**
   * Get total storage used
   */
  async getTotalSize(bookHash?: string): Promise<number> {
    return offlineAudioStorage.getTotalSize(bookHash);
  }

  /**
   * Check if a specific section is downloaded
   */
  async hasSection(bookHash: string, href: string, voiceId: string): Promise<boolean> {
    return offlineAudioStorage.hasAudio(bookHash, href, voiceId);
  }

  /**
   * Get cached audio for playback
   */
  async getAudio(bookHash: string, href: string, voiceId: string): Promise<string | null> {
    const record = await offlineAudioStorage.getAudio(bookHash, href, voiceId);
    return record?.audioData || null;
  }

  /**
   * Get available voices for offline download
   */
  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    // TODO these need fixing. should probably match TTSController.getVoices
    console.log(lang);

    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;

    // 1. Edge TTS Voices
    const edgeVoices = EdgeSpeechTTS.voices;
    const filteredEdgeVoices = edgeVoices.filter(
      (v) => v.lang.startsWith(locale) || (lang === 'en' && ['en-US', 'en-GB'].includes(v.lang)),
    );
    filteredEdgeVoices.sort(TTSUtils.sortVoicesFunc);

    // 2. Kokoro (Http) Voices
    const settings = useSettingsStore.getState().settings;
    const isHttpEnabled = settings.customTTSEndpoint?.enabled ?? false;

    const filteredKokoroVoices = isHttpEnabled
      ? KOKORO_VOICES.filter((v) => v.lang === lang || v.lang === lang.split('-')[0])
      : [];

    const groups: TTSVoicesGroup[] = [];

    if (filteredKokoroVoices.length > 0) {
      groups.push({
        id: 'http-tts',
        name: 'Kokoro TTS',
        voices: filteredKokoroVoices,
      });
    }

    if (filteredEdgeVoices.length > 0) {
      groups.push({
        id: 'edge-tts',
        name: 'Edge TTS',
        voices: filteredEdgeVoices,
      });
    }

    return groups;
  }

  /**
   * Get the voice ID used for a downloaded book
   */
  async getDownloadedVoice(bookHash: string): Promise<string | null> {
    return offlineAudioStorage.getDownloadedVoice(bookHash);
  }

  /**
   * Get the voice ID downloaded for a specific section/chapter.
   * Returns null if no audio exists for this section.
   */
  async getDownloadedVoiceForSection(bookHash: string, href: string): Promise<string | null> {
    return offlineAudioStorage.getDownloadedVoiceForSection(bookHash, href);
  }

  /**
   * Get all downloaded section hrefs for a book in a single query.
   * Returns a Set of base hrefs (without #block-* fragments) that have audio.
   * More efficient than calling getDownloadedVoiceForSection for each section.
   */
  async getAllDownloadedSections(bookHash: string): Promise<Set<string>> {
    return offlineAudioStorage.getAllDownloadedSections(bookHash);
  }

  /**
   * Get all section IDs that have audio chunks stored, including boundary sections
   * downloaded without completion markers. Merges COMPLETION_STORE and AUDIO_STORE results.
   */
  async getAllSectionIdsWithAudio(bookHash: string): Promise<Set<string>> {
    return offlineAudioStorage.getAllSectionIdsWithAudio(bookHash);
  }

  /**
   * Clear error state for a book
   */
  async clearError(bookHash: string): Promise<void> {
    const progress = await offlineAudioStorage.getProgress(bookHash);
    if (progress) {
      delete progress.lastError;
      progress.inProgress = false; // Ensure it's not marked as in progress
      await offlineAudioStorage.saveProgress(progress);

      this.dispatchEvent(
        new CustomEvent('download-error-cleared', {
          detail: { bookHash },
        }),
      );
    }
  }
}

export const offlineAudioManager = new OfflineAudioManager();
export type { DownloadProgress };
