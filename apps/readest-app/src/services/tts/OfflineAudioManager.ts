/**
 * OfflineAudioManager - Orchestrates downloading and managing offline TTS audio
 * Uses Foliate TTS for SSML generation to ensure parity with online TTS highlighting.
 * Supports multiple TTS providers through the TTSProvider interface.
 */

import { TOCItem, BookDoc } from '@/libs/document';
import {
  offlineAudioStorage,
  DownloadProgress,
  MarkTimingInfo,
} from './OfflineAudioStorage';
import { parseSSMLMarks, filterSSMLWithLang } from '@/utils/ssml';
import { simpleHash } from './utils';
import { generateSSMLChunksForSection } from './FoliateTTSHelper';
import { TTSGranularity } from './types';
import { TTSProvider, EdgeTTSProvider } from './providers';

export interface DownloadOptions {
  bookHash: string;
  bookDoc: BookDoc;
  voiceId: string;
  rate: number;
  pitch: number;
  primaryLang: string;
  targetLang?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadSectionOptions {
  bookHash: string;
  bookDoc: BookDoc;
  tocItem: TOCItem;
  voiceId: string;
  rate: number;
  pitch: number;
  primaryLang: string;
  targetLang?: string;
  onProgress?: (downloaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DownloadStatus {
  inProgress: boolean;
  progress: DownloadProgress | null;
  downloadedHrefs: Set<string>;
}

class OfflineAudioManager extends EventTarget {
  private ttsProvider: TTSProvider;
  private activeDownloads = new Map<string, AbortController>();

  constructor(provider?: TTSProvider) {
    super();
    // Default to EdgeTTS provider if none specified
    this.ttsProvider = provider || new EdgeTTSProvider();
  }

  async init(): Promise<void> {
    await offlineAudioStorage.init();
    // Initialize the TTS provider
    const initialized = await this.ttsProvider.init();
    if (!initialized) {
      console.error('[OfflineAudioManager] Failed to initialize TTS provider');
    }
  }

  /**
   * Set a new TTS provider
   * Useful for switching between different TTS engines
   */
  async setProvider(provider: TTSProvider): Promise<void> {
    // Shutdown the old provider to clean up resources
    if (this.ttsProvider) {
      await this.ttsProvider.shutdown();
    }
    
    this.ttsProvider = provider;
    
    // Initialize the new provider
    const initialized = await provider.init();
    if (!initialized) {
      console.error('[OfflineAudioManager] Failed to initialize new TTS provider');
    }
  }

  /**
   * Get the current TTS provider
   */
  getProvider(): TTSProvider {
    return this.ttsProvider;
  }

  /**
   * Preprocess SSML to match TTSController's preprocessing logic.
   * This ensures stored audio matches what TTSController will request during playback.
   */
  private preprocessSSML(ssml: string, targetLang?: string): string {
    // First normalize whitespace within SSML content (collapse newlines/spaces)
    // This must happen before other transformations to ensure consistent text extraction
    ssml = ssml.replace(/\s+/g, ' ');

    // Apply same transformations as TTSController#preprocessSSML
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
          const base64 = result.includes(',') ? (result.split(',')[1] || result) : result;
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
   * Flatten TOC to get all chapters/sections
   */
  private flattenTOC(toc: TOCItem[]): TOCItem[] {
    const result: TOCItem[] = [];
    const flatten = (items: TOCItem[]) => {
      for (const item of items) {
        if (item.href) {
          result.push(item);
        }
        if (item.subitems) {
          flatten(item.subitems);
        }
      }
    };
    flatten(toc);
    return result;
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
  ): Promise<void> {
    const allMarkMetadata: MarkTimingInfo[] = [];
    let cumulativeAudioOffset = 0;
    let totalPlainText = '';

    for (let chunkIndex = 0; chunkIndex < ssmlChunks.length; chunkIndex++) {
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
        // Generate audio for the entire chunk's plain text using the TTS provider
        const { audioBlob, duration: chunkDuration } = await this.ttsProvider.generateAudio({
          lang,
          text: plainText,
          voiceId,
          rate,
          pitch,
        });

        // Convert to base64 for IndexedDB storage (iOS compatibility)
        const base64Audio = await this.blobToBase64(audioBlob);

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

    // Mark section as complete
    await offlineAudioStorage.markSectionComplete(
      bookHash,
      href,
      voiceId,
      ssmlChunks.length,
    );
  }

  /**
   * Download audio for a single section/chapter using Foliate TTS for SSML generation.
   * This ensures exact parity with the online TTS highlighting.
   */
  async downloadSingleSection(options: DownloadSectionOptions): Promise<void> {
    const {
      bookHash,
      bookDoc,
      tocItem,
      voiceId,
      rate,
      pitch,
      primaryLang,
      targetLang,
      onProgress,
      signal: _signal,
    } = options;

    const { href } = tocItem;
    if (!href) {
      throw new Error('TOC item has no href');
    }

    // Check if already fully downloaded
    const isComplete = await offlineAudioStorage.isSectionComplete(bookHash, href, voiceId);
    if (isComplete) {
      onProgress?.(1, 1);
      return;
    }

    const lang = targetLang || primaryLang;
    const granularity: TTSGranularity = 'sentence';

    try {
      // Use Foliate TTS to generate SSML chunks (same as online TTS path)
      const ssmlChunks = await generateSSMLChunksForSection(bookDoc, href, granularity);

      if (ssmlChunks.length === 0) {
        console.warn('[OfflineAudioManager] No SSML chunks generated for href:', href);
        onProgress?.(1, 1);
        return;
      }

      onProgress?.(0, ssmlChunks.length);

      // Download audio for each SSML chunk (block/paragraph)
      await this.downloadSectionWithFoliateTTS(
        bookHash,
        href,
        ssmlChunks,
        voiceId,
        lang,
        rate,
        pitch,
        granularity,
        targetLang,
        onProgress,
      );

      onProgress?.(ssmlChunks.length, ssmlChunks.length);

      this.dispatchEvent(
        new CustomEvent('section-download-complete', {
          detail: { bookHash, href },
        }),
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('section-download-error', {
          detail: {
            bookHash,
            href,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      throw error;
    }
  }

  /**
   * Download audio for entire book
   */
  async downloadBook(options: DownloadOptions): Promise<void> {
    const {
      bookHash,
      bookDoc,
      voiceId,
      rate,
      pitch,
      primaryLang,
      targetLang,
      onProgress,
      signal,
    } = options;

    // Create abort controller
    const abortController = new AbortController();
    this.activeDownloads.set(bookHash, abortController);

    // Listen to external signal
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort());
    }

    try {
      const toc = bookDoc.toc || [];
      const allSections = this.flattenTOC(toc);
      const totalSections = allSections.length;

      // Check existing downloads first
      const existingDownloads = new Set<string>();
      for (const section of allSections) {
        const exists = await offlineAudioStorage.hasAudio(bookHash, section.href, voiceId);
        if (exists) {
          existingDownloads.add(section.href);
        }
      }

      // Initialize progress
      const progress: DownloadProgress = {
        bookHash,
        totalSections,
        downloadedSections: existingDownloads.size,
        failedSections: [],
        inProgress: true,
        startedAt: Date.now(),
      };

      await offlineAudioStorage.saveProgress(progress);
      onProgress?.(progress);

      // Download each section
      for (let i = 0; i < allSections.length; i++) {
        if (abortController.signal.aborted) {
          throw new Error('Download cancelled');
        }

        const section = allSections[i]!;
        const { href } = section;

        try {
          // Skip if already downloaded
          if (existingDownloads.has(href)) {
            continue;
          }

          const lang = targetLang || primaryLang;
          const granularity: TTSGranularity = 'sentence'; // Use sentence granularity for offline audio

          // Use Foliate TTS to generate SSML chunks for exact parity with online TTS
          const ssmlChunks = await generateSSMLChunksForSection(
            bookDoc,
            href,
            granularity,
          );

          if (ssmlChunks.length > 0) {
            await this.downloadSectionWithFoliateTTS(
              bookHash,
              href,
              ssmlChunks,
              voiceId,
              lang,
              rate,
              pitch,
              granularity,
              targetLang,
            );
          }

          progress.downloadedSections++;
          await offlineAudioStorage.saveProgress(progress);
          onProgress?.(progress);

          this.dispatchEvent(
            new CustomEvent('download-progress', {
              detail: {
                bookHash,
                current: i + 1,
                total: totalSections,
                href,
              },
            }),
          );
        } catch (error) {
          console.error('Error downloading section:', href, error);
          progress.failedSections.push(href);
          progress.lastError = error instanceof Error ? error.message : String(error);
          await offlineAudioStorage.saveProgress(progress);
          onProgress?.(progress);
        }
      }

      // Mark as complete
      progress.inProgress = false;
      progress.completedAt = Date.now();
      await offlineAudioStorage.saveProgress(progress);
      onProgress?.(progress);

      this.dispatchEvent(
        new CustomEvent('download-complete', {
          detail: { bookHash, progress },
        }),
      );
    } catch (error) {
      // Handle cancellation or errors
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
      this.activeDownloads.delete(bookHash);
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
  async deleteSingleSection(bookHash: string, href: string, voiceId: string): Promise<void> {
    // Get all audio chunks for this href (including block-0, block-1, etc.)
    const allAudio = await offlineAudioStorage.getBookAudio(bookHash);
    const hrefAudio = allAudio.filter(
      (record) =>
        record.voiceId === voiceId &&
        (record.href === href || record.href.startsWith(`${href}#block-`)),
    );

    // Delete all chunks
    for (const record of hrefAudio) {
      await offlineAudioStorage.deleteAudio(bookHash, record.href, voiceId);
    }

    // Delete completion status
    await offlineAudioStorage.deleteSectionCompletion(bookHash, href, voiceId);

    this.dispatchEvent(
      new CustomEvent('section-download-deleted', {
        detail: { bookHash, href },
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
}

export const offlineAudioManager = new OfflineAudioManager();
