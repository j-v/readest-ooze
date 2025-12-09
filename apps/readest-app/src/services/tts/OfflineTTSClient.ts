import { TTSClient, TTSMessageEvent } from './TTSClient';
import { offlineAudioStorage, OfflineAudioRecord } from './OfflineAudioStorage';
import { parseSSMLMarks, filterSSMLWithLang } from '@/utils/ssml';
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
   * Preprocess SSML to match TTSController's preprocessing logic.
   * This ensures we match against the same SSML that was stored.
   */
  private preprocessSSML(ssml: string, targetLang?: string): string {
    // Apply same transformations as TTSController#preprocessSSML
    ssml = ssml
      .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
      .replace(/[–—]/g, ',')
      .replace('<break/>', ' ')
      .replace(/\.{3,}/g, '   ')
      .replace(/……/g, '  ')
      .replace(/\*/g, ' ')
      .replace(/·/g, ' ');

    if (targetLang) {
      ssml = filterSSMLWithLang(ssml, targetLang);
    }
    return ssml;
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

    // Preprocess SSML to match what was stored during download
    // Use controller's targetLang if available
    const targetLang = this.controller?.ttsTargetLang || undefined;
    const preprocessedSSML = this.preprocessSSML(ssml, targetLang);

    // Parse the incoming SSML to get marks for this block
    const { plainText, marks } = parseSSMLMarks(preprocessedSSML, this.#speakingLang);

    if (!plainText || marks.length === 0) {
      yield { code: 'error', message: 'No content in SSML' } as TTSMessageEvent;
      return;
    }

    // Find matching audio chunk by content hash
    const contentHash = simpleHash(plainText);
    const audioChunk = await this.findAudioChunkByContent(contentHash, plainText);

    if (!audioChunk) {
      yield {
        code: 'error',
        message: 'No offline audio available for this block',
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
      const audioUrl = URL.createObjectURL(audioChunk.audioBlob);

      if (signal.aborted) {
        URL.revokeObjectURL(audioUrl);
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }

      // Estimate mark timing by distributing audio duration across marks
      const audioDuration = await this.getAudioDuration(audioChunk.audioBlob);
      const markTimings = this.estimateMarkTimings(marks, audioDuration);

      // Set up mark emission based on timing
      let currentMarkIndex = 0;

      audio.ontimeupdate = () => {
        const currentTime = audio.currentTime * 1000; // convert to ms

        while (currentMarkIndex < markTimings.length) {
          const markTiming = markTimings[currentMarkIndex]!;
          const correspondingMark = marks[currentMarkIndex];

          if (currentTime >= markTiming.offset) {
            // Emit mark event for highlighting
            if (correspondingMark) {
              this.controller?.dispatchSpeakMark(correspondingMark);
            }
            currentMarkIndex++;
          } else {
            break; // Wait for audio to catch up
          }
        }
      };

      // Emit boundary event for block start
      const firstMark = marks[0];
      if (firstMark) {
        yield {
          code: 'boundary',
          message: `Start block audio`,
          mark: firstMark.name,
        } as TTSMessageEvent;
      }

      // Play the audio
      const result = await new Promise<TTSMessageEvent>((resolve) => {
        const cleanUp = () => {
          audio.onended = null;
          audio.onerror = null;
          audio.ontimeupdate = null;
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
          resolve({ code: 'end', message: 'Block audio finished' });
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
        (record) =>
          record.href.startsWith(this.#sectionHref) && record.voiceId === this.#voiceId,
      );

      // First try to match by content hash
      for (const record of sectionAudio) {
        const recordHash = simpleHash(record.text);
        if (recordHash === contentHash) {
          return record;
        }
      }

      // Fallback: try to match by normalized text
      // TODO this probably won't help but maybe there are some other ideas for fallback
      const normalizedPlainText = plainText.trim().toLowerCase();
      for (const record of sectionAudio) {
        const recordText = record.text.trim().toLowerCase();
        if (recordText === normalizedPlainText) {
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

  /**
   * Get audio duration in milliseconds
   */
  private async getAudioDuration(blob: Blob): Promise<number> {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.preload = 'metadata';

      audio.onloadedmetadata = () => {
        const duration = audio.duration * 1000; // convert to ms
        URL.revokeObjectURL(audio.src);
        resolve(duration);
      };

      audio.onerror = () => {
        URL.revokeObjectURL(audio.src);
        resolve(5000); // Default 5 seconds if can't load TODO not sure if this is helpful
      };

      audio.src = URL.createObjectURL(blob);
    });
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
