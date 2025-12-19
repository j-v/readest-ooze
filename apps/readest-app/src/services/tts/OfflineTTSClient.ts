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
  #audioContext: AudioContext | null = null;
  #audioBuffer: AudioBuffer | null = null;
  #bufferSource: AudioBufferSourceNode | null = null;
  #isPlaying = false;
  #pausedAt = 0; // in seconds relative to buffer
  #playStartCtxTime = 0; // AudioContext.currentTime when started
  #playbackRate = 1.0; // playback speed multiplier
  #markInterval: number | null = null;
  #currentMarkTimings: Array<{ name: string; offset: number; duration: number }> = [];
  #currentMarks: Array<{ name: string; text: string; offset: number; language: string }> = [];

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  private getOrCreateAudioContext(): AudioContext {
    if (!this.#audioContext) {
      this.#audioContext = new AudioContext();
    }
    return this.#audioContext;
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
    audioContext: AudioContext,
    offsetMs: number,
  ) {
    let currentMarkIndex = 0;
    // Find the starting mark index based on current offset
    while (currentMarkIndex < markTimings.length && markTimings[currentMarkIndex]!.offset <= offsetMs) {
      currentMarkIndex++;
    }

    this.stopMarkInterval();
    this.#markInterval = window.setInterval(() => {
      // Calculate elapsed time in audio time (not real time)
      // At 2x speed, 1 second of real time = 2 seconds of audio time
      const realTimeElapsed = audioContext.currentTime - this.#playStartCtxTime;
      const audioTimeElapsed = realTimeElapsed * this.#playbackRate * 1000;
      
      while (currentMarkIndex < markTimings.length) {
        const markTiming = markTimings[currentMarkIndex]!;
        const correspondingMark = marks[currentMarkIndex];
        if (audioTimeElapsed >= markTiming.offset) {
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

  private stopBufferSource() {
    if (this.#bufferSource) {
      this.#bufferSource.onended = null;
      try {
        this.#bufferSource.stop();
      } catch (err) {
        console.warn('[OfflineTTSClient] stopBufferSource error:', err);
      }
      this.#bufferSource.disconnect();
      this.#bufferSource = null;
    }
    this.stopMarkInterval();
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
    if (!this.#bookHash || !this.#sectionHref || !this.#voiceId) {
      console.warn('[OfflineTTSClient] hasOfflineAudio called without context set');
      return false;
    }
    
    try {
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
    return text
      .replace(/\s+/g, ' ') // Collapse multiple whitespace to single space
      .trim();
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
    // For preload mode, just simulate success
    if (preload) {
      yield {
        code: 'end',
        message: 'Preload finished',
      } as TTSMessageEvent;
      return;
    }

    // Preprocess SSML to match what was stored during download
    // Use controller's targetLang if available
    // const targetLang = this.controller?.ttsTargetLang || undefined;
    // const preprocessedSSML = this.preprocessSSML(ssml, targetLang);

    // Parse the incoming SSML to get marks for this block
    const { plainText: rawPlainText, marks } = parseSSMLMarks(
      ssml,
      this.#speakingLang,
    );

    // Normalize whitespace for consistent matching
    const plainText = this.normalizeWhitespace(rawPlainText);

    // if (!plainText || marks.length === 0) {
    //   yield { code: 'error', message: 'No content in SSML' } as TTSMessageEvent;
    //   return;
    // }

    // Find matching audio chunk by content hash
    const contentHash = simpleHash(plainText);
    console.log('[OfflineTTSClient] Looking for audio chunk:', {
      bookHash: this.#bookHash,
      sectionHref: this.#sectionHref,
      voiceId: this.#voiceId,
      contentHash,
      textPreview: plainText.substring(0, 100),
      textLength: plainText.length,
    });
    const audioChunk = await this.findAudioChunkByContent(contentHash, plainText);

    if (!audioChunk) {
      console.warn('[OfflineTTSClient] No audio chunk found for content');
      yield {
        code: 'error',
        message: 'No offline audio available for this block',
      } as TTSMessageEvent;
      return;
    }

    console.log('[OfflineTTSClient] Found audio chunk:', {
      id: audioChunk.id,
      audioDataSize: audioChunk.audioData.length,
      downloadedAt: new Date(audioChunk.downloadedAt).toISOString(),
      textLength: audioChunk.text.length,
    });

    // For preload mode, just verify availability TODO delete
    if (preload) {
      yield {
        code: 'end',
        message: 'Preload finished',
      } as TTSMessageEvent;
      return;
    }

    // Normal playback mode
    await this.stopInternal();

    let abortHandler: null | (() => void) = null;

    try {
      // Validate audio data
      if (!audioChunk.audioData || audioChunk.audioData.length === 0) {
        console.error('[OfflineTTSClient] Invalid audio data:', {
          hasData: !!audioChunk.audioData,
          length: audioChunk.audioData?.length,
        });
        yield { code: 'error', message: 'Invalid audio data' } as TTSMessageEvent;
        return;
      }

      const arrayBuffer = this.base64ToArrayBuffer(audioChunk.audioData);
      const audioContext = this.getOrCreateAudioContext();
      const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      this.#audioBuffer = decodedBuffer;

      const audioDuration = decodedBuffer.duration * 1000;
      const markTimings = this.estimateMarkTimings(marks, audioDuration);
      this.#currentMarkTimings = markTimings;
      this.#currentMarks = marks;

      // Emit boundary event for block start
      const firstMark = marks[0];
      if (firstMark) {
        yield {
          code: 'boundary',
          message: `Start block audio`,
          mark: firstMark.name,
        } as TTSMessageEvent;
      }

      const result = await new Promise<TTSMessageEvent>((resolve) => {
        const startPlayback = (offsetSeconds: number) => {
          if (!this.#audioBuffer) {
            resolve({ code: 'error', message: 'No audio buffer' });
            return;
          }

          const source = audioContext.createBufferSource();
          source.buffer = this.#audioBuffer;
          source.playbackRate.value = this.#playbackRate; // Apply playback rate
          source.connect(audioContext.destination);
          this.#bufferSource = source;
          this.#isPlaying = true;
          // playStartCtxTime tracks when playback started in AudioContext time
          // offsetSeconds is in audio buffer time, so we need to convert to real time
          this.#playStartCtxTime = audioContext.currentTime - (offsetSeconds / this.#playbackRate);
          this.startMarkScheduler(markTimings, marks, audioContext, offsetSeconds * 1000);

          source.onended = () => {
            this.stopMarkInterval();
            this.#isPlaying = false;
            resolve({ code: 'end', message: 'Block audio finished' });
          };

          try {
            source.start(0, offsetSeconds);
          } catch (err) {
            this.stopMarkInterval();
            this.#isPlaying = false;
            console.error('[OfflineTTSClient] AudioContext start failed:', err);
            resolve({ code: 'error', message: 'Playback failed: ' + (err as Error).message });
          }
        };

        abortHandler = () => {
          this.stopBufferSource();
          this.#isPlaying = false;
          resolve({ code: 'error', message: 'Aborted' });
        };

        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener('abort', abortHandler);

        startPlayback(0);
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

  async pause(): Promise<boolean> {
    if (!this.#isPlaying) return true;
    if (!this.#audioContext || !this.#bufferSource) return true;
    // Calculate elapsed time in real time, then convert to buffer time
    const realTimeElapsed = this.#audioContext.currentTime - this.#playStartCtxTime;
    // At 2x speed, 1 second of real time = 2 seconds of buffer time
    this.#pausedAt = Math.max(realTimeElapsed * this.#playbackRate, 0);
    this.stopBufferSource();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    if (this.#isPlaying) return true;
    if (!this.#audioBuffer || !this.#audioContext) return true;
    const audioContext = this.#audioContext;
    const source = audioContext.createBufferSource();
    source.buffer = this.#audioBuffer;
    source.playbackRate.value = this.#playbackRate; // Apply playback rate
    source.connect(audioContext.destination);
    this.#bufferSource = source;
    // pausedAt is in buffer time (seconds), convert to real time for playStartCtxTime
    this.#playStartCtxTime = audioContext.currentTime - (this.#pausedAt / this.#playbackRate);
    this.#isPlaying = true;

    if (this.#currentMarkTimings.length && this.#currentMarks.length) {
      this.startMarkScheduler(
        this.#currentMarkTimings,
        this.#currentMarks,
        audioContext,
        this.#pausedAt * 1000,
      );
    }

    source.onended = () => {
      this.stopMarkInterval();
      this.#isPlaying = false;
    };

    try {
      source.start(0, this.#pausedAt);
    } catch (err) {
      console.error('[OfflineTTSClient] Resume failed:', err);
      this.stopBufferSource();
      this.#isPlaying = false;
    }
    return true;
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private async stopInternal(): Promise<void> {
    this.#isPlaying = false;
    this.#pausedAt = 0;
    this.stopBufferSource();
  }

  async setRate(rate: number): Promise<void> {
    // Store the new rate for future playback
    this.#playbackRate = rate;
    
    // If currently playing, update the playback rate dynamically
    if (this.#bufferSource && this.#isPlaying) {
      try {
        this.#bufferSource.playbackRate.value = rate;
        console.log(`[OfflineTTSClient] Playback rate updated to ${rate}`);
      } catch (err) {
        console.error('[OfflineTTSClient] Failed to update playback rate:', err);
      }
    }
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
