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
   * Segment text using Intl.Segmenter (same as foliate-js TTS)
   * Returns segments with metadata for mapping back to original text
   */
  private segmentText(
    text: string,
    lang: string,
    granularity: 'sentence' | 'word' = 'sentence',
  ): Array<{ text: string; offset: number; index: number }> {
    const segmenter = new Intl.Segmenter(lang, { granularity });
    const segments: Array<{ text: string; offset: number; index: number }> = [];
    
    const cleanText = text.replace(/\r\n/g, '  ').replace(/\r/g, ' ').replace(/\n/g, ' ');
    const rawSegments = Array.from(segmenter.segment(cleanText));
    
    // Merge segments that end with abbreviations followed by capitalized words
    // This prevents splitting sentences like "Dr. Smith went..." into multiple segments
    const mergedSegments = [];
    for (let i = 0; i < rawSegments.length; i++) {
      const current = rawSegments[i]!;
      const next = rawSegments[i + 1];
      const segment = current.segment.trim();
      const nextSegment = next?.segment?.trim();
      
      const endsWithAbbr = /(?:^|\s)([A-Z][a-z]{1,5})\.$/.test(segment);
      const nextStartsWithCapital = /^[A-Z]/.test(nextSegment || '');
      
      if (endsWithAbbr && nextStartsWithCapital && next) {
        mergedSegments.push({
          index: current.index,
          segment: current.segment + next.segment,
        });
        i++; // Skip the next segment since we merged it
      } else {
        mergedSegments.push({
          index: current.index,
          segment: current.segment,
        });
      }
    }
    
    // Filter and collect meaningful segments
    let segmentIndex = 0;
    for (const { index, segment } of mergedSegments) {
      const trimmed = segment.trim();
      if (trimmed) {
        segments.push({
          text: trimmed,
          offset: index,
          index: segmentIndex++,
        });
      }
    }
    
    return segments;
  }

  /**
   * Chunk segments into groups that fit within TTS character limits
   * Preserves segment boundaries for proper mapping
   */
  private chunkSegments(
    segments: Array<{ text: string; offset: number; index: number }>,
    maxChars: number = 3000,
  ): Array<Array<{ text: string; offset: number; index: number }>> {
    const chunks: Array<Array<{ text: string; offset: number; index: number }>> = [];
    let currentChunk: Array<{ text: string; offset: number; index: number }> = [];
    let currentLength = 0;
    
    for (const segment of segments) {
      const segmentLength = segment.text.length;
      
      // If adding this segment would exceed the limit and we have segments, start a new chunk
      if (currentLength + segmentLength > maxChars && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [segment];
        currentLength = segmentLength;
      } else {
        currentChunk.push(segment);
        currentLength += segmentLength;
      }
    }
    
    // Add the last chunk if it has content
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    return chunks;
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

    // Segment text using Intl.Segmenter (same approach as foliate-js TTS)
    const segments = this.segmentText(text, lang, 'sentence');
    
    // Chunk segments to fit within TTS limits while preserving sentence boundaries
    const chunks = this.chunkSegments(segments, 3000);

    // Download audio for each chunk
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex]!;
      
      // Join segments in this chunk with spaces
      const chunkText = chunk.map(seg => seg.text).join(' ');
      
      const payload: EdgeTTSPayload = {
        lang,
        text: chunkText,
        voice: voiceId,
        rate,
        pitch,
      };

      try {
        // Use EdgeSpeechTTS directly to get the audio
        const response = await this.edgeTTS.create(payload);
        const arrayBuffer = await response.arrayBuffer();
        const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
        
        // Store with chunk metadata for later playback mapping
        const chunkHref = chunks.length > 1 ? `${href}#chunk-${chunkIndex}` : href;
        
        // Store segment metadata as JSON string for later mapping
        const segmentMetadata = chunk.map(seg => ({
          text: seg.text,
          offset: seg.offset,
          index: seg.index,
        }));
        
        await offlineAudioStorage.saveAudio({
          bookHash,
          href: chunkHref,
          voiceId,
          audioBlob,
          rate,
          pitch,
          text: chunkText,
          ssml: JSON.stringify(segmentMetadata), // Store segment metadata for playback
          downloadedAt: Date.now(),
          size: audioBlob.size,
        });
      } catch (error) {
        console.error('Error downloading audio chunk:', chunkIndex, error);
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
