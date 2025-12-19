/**
 * EdgeTTSProvider - Edge TTS implementation of TTSProvider
 * Wraps EdgeSpeechTTS for use with OfflineAudioManager
 */

import { EdgeSpeechTTS } from '@/libs/edgeTTS';
import { getAudioDuration } from '../utils';
import { TTSProvider, TTSGenerationOptions, TTSAudioResult } from './TTSProvider';

export class EdgeTTSProvider implements TTSProvider {
  readonly name = 'edge-tts';
  private edgeTTS: EdgeSpeechTTS;
  private initialized = false;

  constructor() {
    this.edgeTTS = new EdgeSpeechTTS();
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      // EdgeSpeechTTS is ready to use immediately - no async initialization needed
      // Just verify that we have access to voices
      const voices = EdgeSpeechTTS.voices;
      if (!voices || voices.length === 0) {
        throw new Error('No voices available');
      }
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('[EdgeTTSProvider] Initialization failed:', error);
      this.initialized = false;
      return false;
    }
  }

  async generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult> {
    const { lang, text, voiceId, rate, pitch } = options;

    try {
      const response = await this.edgeTTS.create({
        lang,
        text,
        voice: voiceId,
        rate,
        pitch,
      });

      const arrayBuffer = await response.arrayBuffer();
      const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });

      // Get audio duration
      const duration = await getAudioDuration(audioBlob);

      return {
        audioBlob,
        duration,
      };
    } catch (error) {
      console.error('[EdgeTTSProvider] Failed to generate audio:', error);
      throw error;
    }
  }

  async getVoicesForLang(lang: string): Promise<string[]> {
    const voices = EdgeSpeechTTS.voices;
    return voices.filter((v) => v.lang.startsWith(lang)).map((v) => v.id);
  }

  async shutdown(): Promise<void> {
    // EdgeSpeechTTS doesn't require cleanup
    this.initialized = false;
  }
}
