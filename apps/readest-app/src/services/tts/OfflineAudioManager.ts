/**
 * OfflineAudioManager - Orchestrates downloading and managing offline TTS audio
 */

import { TOCItem, BookDoc } from '@/libs/document';
import { offlineAudioStorage, DownloadProgress } from './OfflineAudioStorage';
import { EdgeSpeechTTS, EdgeTTSPayload } from '@/libs/edgeTTS';

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

export interface DownloadStatus {
  inProgress: boolean;
  progress: DownloadProgress | null;
  downloadedHrefs: Set<string>;
}

class OfflineAudioManager extends EventTarget {
  private edgeTTS: EdgeSpeechTTS;
  private activeDownloads = new Map<string, AbortController>();

  constructor() {
    super();
    this.edgeTTS = new EdgeSpeechTTS();
  }

  async init(): Promise<void> {
    await offlineAudioStorage.init();
    // Test EdgeTTS to ensure it's working
    try {
      await this.edgeTTS.create({
        lang: 'en',
        text: 'test',
        voice: 'en-US-AriaNeural',
        rate: 1.0,
        pitch: 1.0,
      });
    } catch (error) {
      console.error('EdgeTTS initialization failed:', error);
    }
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
   * Extract text content from a section
   */
  private async getSectionText(bookDoc: BookDoc, href: string): Promise<string> {
    const section = bookDoc.sections?.find((s) => {
      const sectionHref = s.id || '';
      return href.includes(sectionHref) || sectionHref.includes(href);
    });

    if (!section) {
      console.warn('Section not found for href:', href);
      return '';
    }

    try {
      const doc = await section.createDocument();
      const bodyText = doc.body?.textContent || '';
      return bodyText.trim();
    } catch (error) {
      console.error('Error extracting section text:', error);
      return '';
    }
  }

  /**
   * Download audio for a single section
   */
  private async downloadSection(
    bookHash: string,
    href: string,
    text: string,
    voiceId: string,
    lang: string,
    rate: number,
    pitch: number,
  ): Promise<void> {
    if (!text) {
      console.warn('No text to download for href:', href);
      return;
    }

    // Split text into chunks (Edge TTS has limits on text length)
    const MAX_CHARS = 3000;
    const chunks: string[] = [];
    
    // Simple sentence-based chunking
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > MAX_CHARS && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    // Download audio for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const payload: EdgeTTSPayload = {
        lang,
        text: chunk,
        voice: voiceId,
        rate,
        pitch,
      };

      try {
        // Use EdgeSpeechTTS directly to get the audio
        const response = await this.edgeTTS.create(payload);
        const arrayBuffer = await response.arrayBuffer();
        const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
        
        // Store with chunk index to maintain order
        const chunkHref = chunks.length > 1 ? `${href}#chunk-${i}` : href;
        
        await offlineAudioStorage.saveAudio({
          bookHash,
          href: chunkHref,
          voiceId,
          audioBlob,
          rate,
          pitch,
          text: chunk,
          ssml: chunk,
          downloadedAt: Date.now(),
          size: audioBlob.size,
        });
      } catch (error) {
        console.error('Error downloading audio chunk:', i, error);
        throw error;
      }
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

          const text = await this.getSectionText(bookDoc, href);
          const lang = targetLang || primaryLang;
          await this.downloadSection(bookHash, href, text, voiceId, lang, rate, pitch);

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
    const downloadedHrefs = await offlineAudioStorage.getDownloadedHrefs(bookHash, voiceId);

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
  async getAudio(bookHash: string, href: string, voiceId: string): Promise<Blob | null> {
    const record = await offlineAudioStorage.getAudio(bookHash, href, voiceId);
    return record?.audioBlob || null;
  }
}

export const offlineAudioManager = new OfflineAudioManager();
