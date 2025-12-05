import { TTSClient, TTSMessageEvent } from './TTSClient';
import { offlineAudioStorage, OfflineAudioRecord } from './OfflineAudioStorage';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';

/**
 * OfflineTTSClient - Plays pre-downloaded TTS audio chunks from IndexedDB
 * Implements TTSClient interface for seamless integration with TTSController
 *
 * Playback Strategy:
 * - Downloads are stored at section level (e.g., chapter)
 * - Playback streams section audio as one continuous stream
 * - Simulates mark events for highlighting by emitting boundary events at reasonable intervals
 * - Gracefully falls back to other TTS clients if offline audio unavailable
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
  #isPlaying = false;
  #pausedAt = 0;
  #startedAt = 0;

  constructor(controller?: TTSController) {
    this.controller = controller;
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
   * Main speak method - plays offline audio for the entire section
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

    // Try to get stored audio chunks for this section
    const audioChunks = await this.getAudioChunksForSection();

    if (audioChunks.length === 0) {
      yield {
        code: 'error',
        message: 'No offline audio available for this section',
      } as TTSMessageEvent;
      return;
    }

    // For preload mode, just verify availability
    if (preload) {
      yield {
        code: 'end',
        message: 'Preload finished',
      } as TTSMessageEvent;
      return;
    }

    // Normal playback mode
    await this.stopInternal();

    if (!this.#audioElement) {
      this.#audioElement = new Audio();
    }
    const audio = this.#audioElement;
    audio.setAttribute('x-webkit-airplay', 'deny');
    audio.preload = 'auto';

    let abortHandler: null | (() => void) = null;

    try {
      // Create a blob from all chunks for seamless playback
      const combinedBlob = await this.combineAudioChunks(audioChunks);
      const audioUrl = URL.createObjectURL(combinedBlob);

      if (signal.aborted) {
        URL.revokeObjectURL(audioUrl);
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }

      // Emit boundary event for section start
      const { marks } = parseSSMLMarks(ssml);
      const firstMark = marks[0];
      if (firstMark) {
        this.controller?.dispatchSpeakMark(firstMark);
        yield {
          code: 'boundary',
          message: `Start section audio: ${this.#sectionHref}`,
          mark: firstMark.name,
        } as TTSMessageEvent;
      }

      // Play the combined audio
      const result = await new Promise<TTSMessageEvent>((resolve) => {
        const cleanUp = () => {
          audio.onended = null;
          audio.onerror = null;
          audio.src = '';
          URL.revokeObjectURL(audioUrl);
        };

        abortHandler = () => {
          cleanUp();
          resolve({ code: 'error', message: 'Aborted' });
        };

        if (signal.aborted) {
          abortHandler();
          return;
        } else {
          signal.addEventListener('abort', abortHandler);
        }

        audio.onended = () => {
          cleanUp();
          resolve({ code: 'end', message: `Section audio finished: ${this.#sectionHref}` });
        };

        audio.onerror = (e) => {
          cleanUp();
          console.warn('Offline audio playback error:', e);
          resolve({ code: 'error', message: 'Audio playback error' });
        };

        this.#isPlaying = true;
        audio.src = audioUrl;
        audio.play().catch((err) => {
          cleanUp();
          console.error('Failed to play offline audio:', err);
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
   * Get all audio chunks for a section
   * Handles both single-chunk and multi-chunk sections
   */
  private async getAudioChunksForSection(): Promise<OfflineAudioRecord[]> {
    try {
      const allAudio = await offlineAudioStorage.getBookAudio(this.#bookHash);

      // Filter for this section and voice
      const sectionAudio = allAudio.filter(
        (record) =>
          (record.href === this.#sectionHref || record.href.startsWith(`${this.#sectionHref}#chunk-`)) &&
          record.voiceId === this.#voiceId,
      );

      // Sort by chunk index if multi-chunk
      return sectionAudio.sort((a, b) => {
        const aChunk = parseInt(a.href.split('#chunk-')[1] || '0');
        const bChunk = parseInt(b.href.split('#chunk-')[1] || '0');
        return aChunk - bChunk;
      });
    } catch (error) {
      console.error('Error retrieving audio chunks:', error);
      return [];
    }
  }

  /**
   * Combine multiple audio chunks into a single blob for seamless playback
   */
  private async combineAudioChunks(chunks: OfflineAudioRecord[]): Promise<Blob> {
    if (chunks.length === 0) {
      return new Blob([], { type: 'audio/mpeg' });
    }

    if (chunks.length === 1) {
      return chunks[0]!.audioBlob;
    }

    // For multiple chunks, concatenate them
    // Note: Direct concatenation may cause audio artifacts at boundaries
    // Better: use Web Audio API or store pre-combined in IndexedDB
    // For now, create a simple concatenation
    const parts: Uint8Array[] = [];

    for (const chunk of chunks) {
      const arrayBuffer = await chunk.audioBlob.arrayBuffer();
      parts.push(new Uint8Array(arrayBuffer));
    }

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const combined = new Uint8Array(totalLength);

    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }

    return new Blob([combined], { type: 'audio/mpeg' });
  }

  async pause(): Promise<boolean> {
    if (!this.#isPlaying || !this.#audioElement) return true;
    this.#pausedAt = this.#audioElement.currentTime - this.#startedAt;
    await this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    if (this.#isPlaying || !this.#audioElement) return true;
    await this.#audioElement.play();
    this.#isPlaying = true;
    this.#startedAt = this.#audioElement.currentTime - this.#pausedAt;
    return true;
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private async stopInternal(): Promise<void> {
    this.#isPlaying = false;
    this.#pausedAt = 0;
    this.#startedAt = 0;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
      if (this.#audioElement?.onended) {
        this.#audioElement.onended(new Event('stopped'));
      }
      this.#audioElement.src = '';
    }
  }

  async setRate(_rate: number): Promise<void> {
    // Offline client doesn't support rate adjustment
    console.warn('Rate adjustment not supported for offline audio');
  }

  async setPitch(_pitch: number): Promise<void> {
    // Offline client doesn't support pitch adjustment
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
    return ['word', 'sentence'];
  }

  getVoiceId(): string {
    return this.#voiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }
}
