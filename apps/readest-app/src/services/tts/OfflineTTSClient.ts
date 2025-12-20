import { TTSClient, TTSMessageEvent } from './TTSClient';
import { offlineAudioStorage, OfflineAudioRecord } from './OfflineAudioStorage';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { simpleHash } from './utils';

/**
 * OfflineTTSClient - Plays pre-downloaded TTS audio chunks from IndexedDB
 * Implements TTSClient interface for seamless integration with TTSController
 *
 * Playback Strategy:
 * - Audio is stored per-block (matching Foliate TTS block/paragraph structure)
 * - Each speak() call receives SSML for one block and plays matching audio
 * - Marks within the block are used for highlighting synchronization
 * - TTSController handles progression between blocks via forward()
 */
export class OfflineTTSClient implements TTSClient {
  name = 'offline-tts';
  initialized = false;
  controller?: TTSController;

  #bookHash: string = '';
  #sectionHref: string = '';
  #voiceId: string = '';
  #speakingLang: string = 'en';
  #audioElement: HTMLAudioElement | null = null;
  #currentAudioUrl: string | null = null;
  #isPlaying = false;
  #pausedAt = 0; // seconds
  #playbackRate = 1.0;
  #isStopping = false;
  #markInterval: number | null = null;
  #currentMarkTimings: Array<{ name: string; offset: number; duration: number }> = [];
  #currentMarks: Array<{ name: string; text: string; offset: number; language: string }> = [];

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  private getOrCreateAudioElement(): HTMLAudioElement {
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
      this.#audioElement.preload = 'auto';
      this.#audioElement.setAttribute('playsinline', 'true');
      this.#audioElement.setAttribute('x-webkit-airplay', 'deny');
      this.#audioElement.playbackRate = this.#playbackRate;
      this.#audioElement.defaultPlaybackRate = this.#playbackRate;
      const el = this.#audioElement as HTMLAudioElement & {
        preservesPitch?: boolean;
        webkitPreservesPitch?: boolean;
        mozPreservesPitch?: boolean;
      };
      el.preservesPitch = true;
      el.webkitPreservesPitch = true;
      el.mozPreservesPitch = true;
    }
    return this.#audioElement;
  }

  private stopMarkInterval() {
    if (this.#markInterval !== null) {
      clearInterval(this.#markInterval);
      this.#markInterval = null;
    }
  }

  private startMarkScheduler(
    markTimings: Array<{ name: string; offset: number; duration: number }>,
    marks: Array<{ name: string; text: string; offset: number; language: string }>,
    getElapsedMs: () => number,
    offsetMs: number,
  ) {
    let currentMarkIndex = 0;
    while (
      currentMarkIndex < markTimings.length &&
      markTimings[currentMarkIndex]!.offset <= offsetMs
    ) {
      currentMarkIndex++;
    }

    this.stopMarkInterval();
    this.#markInterval = window.setInterval(() => {
      const elapsedMs = getElapsedMs();
      while (currentMarkIndex < markTimings.length) {
        const markTiming = markTimings[currentMarkIndex]!;
        const correspondingMark = marks[currentMarkIndex];
        if (elapsedMs >= markTiming.offset) {
          if (correspondingMark) {
            this.controller?.dispatchSpeakMark(correspondingMark);
          }
          currentMarkIndex++;
        } else {
          break;
        }
      }
    }, 50);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async init(): Promise<boolean> {
    try {
      await offlineAudioStorage.init();
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('OfflineTTSClient initialization failed:', error);
      this.initialized = false;
      return false;
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Set the context for this playback session
   * bookHash: stable book identifier (metaHash)
   * sectionHref: the TOC section/chapter href to play
   * voiceId: voice used for this audio
   * lang: language of the audio
   */
  setContext(bookHash: string, sectionHref: string, voiceId: string, lang?: string): void {
    this.#bookHash = bookHash;
    this.#sectionHref = sectionHref;
    this.#voiceId = voiceId;
    if (lang) this.#speakingLang = lang;
  }

  /**
   * Check if offline audio is available for the current context
   * Must be called after setContext()
   * Returns: Promise<boolean> - true if offline audio chunks exist for this section
   */
  async hasOfflineAudio(): Promise<boolean> {
    if (!this.#bookHash || !this.#sectionHref) {
      console.warn('[OfflineTTSClient] hasOfflineAudio called without context set');
      return false;
    }

    try {
      // Check if there is a specific voice downloaded for this book
      const downloadedVoiceId = await offlineAudioStorage.getDownloadedVoice(this.#bookHash);

      // If we found a specific voice downloaded for this book, use it instead of the requested one
      if (downloadedVoiceId && downloadedVoiceId !== this.#voiceId) {
        console.log(
          `[OfflineTTSClient] Using downloaded voice ${downloadedVoiceId} instead of requested ${this.#voiceId}`,
        );
        this.#voiceId = downloadedVoiceId;
      }

      if (!this.#voiceId) {
        return false;
      }

      const allAudio = await offlineAudioStorage.getBookAudio(this.#bookHash);
      const sectionAudio = allAudio.filter(
        (record) => record.href.startsWith(this.#sectionHref) && record.voiceId === this.#voiceId,
      );

      const hasAudio = sectionAudio.length > 0;
      console.log('[OfflineTTSClient] hasOfflineAudio check:', {
        bookHash: this.#bookHash,
        sectionHref: this.#sectionHref,
        voiceId: this.#voiceId,
        chunksAvailable: sectionAudio.length,
        hasAudio,
      });

      return hasAudio;
    } catch (error) {
      console.error('[OfflineTTSClient] Error checking audio availability:', error);
      return false;
    }
  }

  /**
   * Normalize whitespace in plain text to ensure consistent matching.
   * Collapses multiple spaces and normalizes line endings.
   */
  private normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Main speak method - plays offline audio for a single block/paragraph
   * The SSML passed in is for one block (matching Foliate TTS structure)
   * Returns error code if audio not available (fallback to other client)
   */
  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload?: boolean,
  ): AsyncIterable<TTSMessageEvent> {
    if (!this.#bookHash || !this.#sectionHref || !this.#voiceId) {
      yield { code: 'error', message: 'Offline client context not set' } as TTSMessageEvent;
      return;
    }
    // For offline, preload is a no-op
    if (preload) {
      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    const { plainText: rawPlainText, marks } = parseSSMLMarks(ssml, this.#speakingLang);
    const plainText = this.normalizeWhitespace(rawPlainText);

    const contentHash = simpleHash(plainText);
    const audioChunk = await this.findAudioChunkByContent(contentHash, plainText);

    if (!audioChunk) {
      console.warn('[OfflineTTSClient] No audio chunk found for content');
      yield {
        code: 'error',
        message: 'No offline audio available for this block',
      } as TTSMessageEvent;
      return;
    }

    await this.stopInternal();

    let abortHandler: null | (() => void) = null;

    try {
      if (!audioChunk.audioData || audioChunk.audioData.length === 0) {
        yield { code: 'error', message: 'Invalid audio data' } as TTSMessageEvent;
        return;
      }

      const arrayBuffer = this.base64ToArrayBuffer(audioChunk.audioData);
      const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      this.#currentAudioUrl = audioUrl;

      const audio = this.getOrCreateAudioElement();
      audio.src = audioUrl;
      audio.currentTime = 0;
      audio.playbackRate = this.#playbackRate;
      audio.defaultPlaybackRate = this.#playbackRate;
      audio.load();

      if (typeof audioChunk.durationMs === 'number' && audioChunk.durationMs > 0) {
        this.#currentMarkTimings = this.estimateMarkTimings(marks, audioChunk.durationMs);
      } else {
        this.#currentMarkTimings = [];
      }
      this.#currentMarks = marks;

      const firstMark = marks[0];
      if (firstMark) {
        yield {
          code: 'boundary',
          message: 'Start block audio',
          mark: firstMark.name,
        } as TTSMessageEvent;
      }

      const result = await new Promise<TTSMessageEvent>((resolve) => {
        const cleanup = () => {
          audio.onended = null;
          audio.onerror = null;
          audio.onloadedmetadata = null;
          this.stopMarkInterval();
          if (this.#currentAudioUrl) {
            URL.revokeObjectURL(this.#currentAudioUrl);
            this.#currentAudioUrl = null;
          }
        };

        const ensureMarkScheduler = (offsetMs: number) => {
          const durationMs =
            typeof audioChunk.durationMs === 'number' && audioChunk.durationMs > 0
              ? audioChunk.durationMs
              : Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration * 1000
                : 0;

          if (durationMs > 0) {
            this.#currentMarkTimings = this.estimateMarkTimings(marks, durationMs);
          }

          if (this.#currentMarkTimings.length === 0) return;

          this.startMarkScheduler(
            this.#currentMarkTimings,
            this.#currentMarks,
            () => audio.currentTime * 1000,
            offsetMs,
          );
        };

        abortHandler = () => {
          this.stopMarkInterval();
          audio.pause();
          cleanup();
          this.#isPlaying = false;
          resolve({ code: 'error', message: 'Aborted' });
        };

        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener('abort', abortHandler);

        audio.onloadedmetadata = () => {
          ensureMarkScheduler(this.#pausedAt * 1000);
        };

        audio.onended = () => {
          cleanup();
          this.#isPlaying = false;
          resolve({ code: 'end', message: 'Block audio finished' });
        };

        audio.onerror = (event) => {
          console.warn('Offline audio playback error:', event);
          cleanup();
          this.#isPlaying = false;
          resolve({ code: 'error', message: 'Audio playback error' });
        };

        if (this.#currentMarkTimings.length > 0) {
          ensureMarkScheduler(0);
        }

        this.#isPlaying = true;
        audio.play().catch((err: Error) => {
          cleanup();
          this.#isPlaying = false;
          resolve({ code: 'error', message: 'Playback failed: ' + err.message });
        });
      });

      yield result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Offline TTS error:', message);
      yield { code: 'error', message } as TTSMessageEvent;
    } finally {
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  /**
   * Find an audio chunk that matches the given content
   * Uses content hash for fast lookup, falls back to text comparison
   */
  private async findAudioChunkByContent(
    contentHash: string,
    plainText: string,
  ): Promise<OfflineAudioRecord | null> {
    try {
      const allAudio = await offlineAudioStorage.getBookAudio(this.#bookHash);

      // Filter for this section and voice
      const sectionAudio = allAudio.filter(
        (record) => record.href.startsWith(this.#sectionHref) && record.voiceId === this.#voiceId,
      );

      // First try to match by content hash
      for (const record of sectionAudio) {
        const recordHash = simpleHash(this.normalizeWhitespace(record.text));
        if (recordHash === contentHash) {
          return record;
        }
      }

      // Fallback: try to match by normalized text
      // TODO this probably won't help but maybe there are some other ideas for fallback
      const normalizedPlainText = plainText.trim().toLowerCase();
      for (const record of sectionAudio) {
        const recordText = this.normalizeWhitespace(record.text).trim().toLowerCase();
        if (recordText === normalizedPlainText || recordText.includes(normalizedPlainText)) {
          return record;
        }
      }

      console.warn('[OfflineTTSClient] No matching audio chunk found for content:', {
        contentHash,
        textPreview: plainText.substring(0, 50),
        availableChunks: sectionAudio.length,
      });

      return null;
    } catch (error) {
      console.error('Error finding audio chunk:', error);
      return null;
    }
  }

  /**
   * Estimate mark timing by distributing audio duration proportionally
   */
  private estimateMarkTimings(
    marks: Array<{ name: string; text: string; offset: number; language: string }>,
    totalDuration: number,
  ): Array<{ name: string; offset: number; duration: number }> {
    const totalChars = marks.reduce((sum, m) => sum + m.text.length, 0);
    let offset = 0;

    return marks.map((mark) => {
      const duration = (mark.text.length / Math.max(totalChars, 1)) * totalDuration;
      const result = { name: mark.name, offset, duration };
      offset += duration;
      return result;
    });
  }

  async pause(): Promise<boolean> {
    if (!this.#isPlaying || !this.#audioElement) return true;
    this.#pausedAt = this.#audioElement.currentTime;
    this.stopMarkInterval();
    await this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    if (this.#isPlaying || !this.#audioElement || !this.#audioElement.src) return true;
    this.#audioElement.currentTime = this.#pausedAt;
    this.#audioElement.playbackRate = this.#playbackRate;
    this.#audioElement.defaultPlaybackRate = this.#playbackRate;

    if (this.#currentMarkTimings.length && this.#currentMarks.length) {
      this.startMarkScheduler(
        this.#currentMarkTimings,
        this.#currentMarks,
        () => this.#audioElement!.currentTime * 1000,
        this.#pausedAt * 1000,
      );
    }

    this.#isPlaying = true;
    try {
      await this.#audioElement.play();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If playback was aborted because the source changed during stop, ignore
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.#isPlaying = false;
        return true;
      }
      if (typeof message === 'string' && message.includes('aborted by the user agent')) {
        this.#isPlaying = false;
        return true;
      }
      console.error('[OfflineTTSClient] Resume failed:', err);
      this.#isPlaying = false;
    }
    return true;
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private async stopInternal(): Promise<void> {
    // Prevent re-entrant calls
    if (this.#isStopping) return;
    this.#isStopping = true;

    this.#isPlaying = false;
    this.#pausedAt = 0;
    this.stopMarkInterval();
    if (this.#audioElement) {
      // Clean up event handlers before clearing src to prevent error events
      this.#audioElement.onended = null;
      this.#audioElement.onerror = null;
      this.#audioElement.onloadedmetadata = null;
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
    }
    if (this.#currentAudioUrl) {
      URL.revokeObjectURL(this.#currentAudioUrl);
      this.#currentAudioUrl = null;
    }

    this.#isStopping = false;
  }

  async setRate(rate: number): Promise<void> {
    this.#playbackRate = Math.max(0.5, Math.min(rate, 3.0));
    if (this.#audioElement) {
      this.#audioElement.playbackRate = this.#playbackRate;
      this.#audioElement.defaultPlaybackRate = this.#playbackRate;
      const el = this.#audioElement as HTMLAudioElement & {
        preservesPitch?: boolean;
        webkitPreservesPitch?: boolean;
        mozPreservesPitch?: boolean;
      };
      el.preservesPitch = true;
      el.webkitPreservesPitch = true;
      el.mozPreservesPitch = true;
    }
  }

  async setPitch(_pitch: number): Promise<void> {
    console.warn('Pitch adjustment not supported for offline audio');
  }

  async setVoice(voice: string): Promise<void> {
    this.#voiceId = voice;
  }

  async setPrimaryLang(_lang: string): Promise<void> {
    // Offline uses stored language from audio
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return [];
  }

  async getVoices(_lang: string): Promise<TTSVoicesGroup[]> {
    return [];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#voiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }
}
