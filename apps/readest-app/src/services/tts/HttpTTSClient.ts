import { TTSClient, TTSMessageEvent } from './TTSClient';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { HttpTTSProvider } from './providers/HttpTTSProvider';
import { md5 } from 'js-md5';
import { LRUCache } from '@/utils/lru';

export interface TTSPayload {
  lang: string;
  text: string;
  voice: string;
  rate: number;
}

const hashPayload = (payload: TTSPayload): string => {
  const base = JSON.stringify(payload);
  return md5(base);
};

/**
 * HttpTTSClient - Custom TTS client using HttpTTSProvider
 * Sends text to a remote HTTP TTS service and plays back audio
 */
export class HttpTTSClient implements TTSClient {
  name = 'http-tts';
  initialized = false;
  controller?: TTSController;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = 'af_alloy';
  #rate = 1.0;
    
  #provider: HttpTTSProvider;
  #audioElement: HTMLAudioElement | null = null;
  #isPlaying = false;

  private static audioUrlCache = new LRUCache<string, string>(200, (_, url) => {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  });

  constructor(controller?: TTSController) {
    this.controller = controller;
    this.#provider = new HttpTTSProvider({
      endpoint: 'http://100.71.209.91:8000/tts',
      timeoutMs: 30000,
    });

    // Kokoro voices
    this.#voices = [
      {"id": "af_alloy", "name": "Alloy", "lang": "en"},
      {"id": "af_aoede", "name": "Aoede", "lang": "en"},
      {"id": "af_bella", "name": "Bella", "lang": "en"},
      {"id": "af_heart", "name": "Heart", "lang": "en"},
      {"id": "af_jessica", "name": "Jessica", "lang": "en"},
      {"id": "af_kore", "name": "Kore", "lang": "en"},
      {"id": "af_nicole", "name": "Nicole", "lang": "en"},
      {"id": "af_nova", "name": "Nova", "lang": "en"},
      {"id": "af_river", "name": "River", "lang": "en"},
      {"id": "af_sarah", "name": "Sarah", "lang": "en"},
      {"id": "af_sky", "name": "Sky", "lang": "en"},
      {"id": "am_adam", "name": "Adam", "lang": "en"},
      {"id": "am_echo", "name": "Echo", "lang": "en"},
      {"id": "am_eric", "name": "Eric", "lang": "en"},
      {"id": "am_fenrir", "name": "Fenrir", "lang": "en"},
      {"id": "am_liam", "name": "Liam", "lang": "en"},
      {"id": "am_michael", "name": "Michael", "lang": "en"},
      {"id": "am_onyx", "name": "Onyx", "lang": "en"},
      {"id": "am_puck", "name": "Puck", "lang": "en"},
      {"id": "am_santa", "name": "Santa", "lang": "en"},
      {"id": "bf_alice", "name": "Alice", "lang": "en"},
      {"id": "bf_emma", "name": "Emma", "lang": "en"},
      {"id": "bf_isabella", "name": "Isabella", "lang": "en"},
      {"id": "bf_lily", "name": "Lily", "lang": "en"},
      {"id": "bm_daniel", "name": "Daniel", "lang": "en"},
      {"id": "bm_fable", "name": "Fable", "lang": "en"},
      {"id": "bm_george", "name": "George", "lang": "en"},
      {"id": "bm_lewis", "name": "Lewis", "lang": "en"}
    ]
    this.#currentVoiceId = 'af_alloy';
  }

  async init(): Promise<boolean> {
    try {
      await this.#provider.init();
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize HTTP TTS provider:', error);
      this.initialized = false;
    }
    return this.initialized;
  }

  async shutdown(): Promise<void> {
    await this.stopInternal();
    if (this.#provider.dispose) {
      await this.#provider.dispose();
    }
    this.initialized = false;
    this.#voices = [];

    // TODO could clear preload cache here
  }

  getVoiceIdFromLang = async (lang: string): Promise<string> => {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferredVoice = this.#voices.find((v) => v.id === preferredVoiceId);
    if (preferredVoice) return preferredVoice.id;

    // Default to af_alloy
    return this.#currentVoiceId || 'af_alloy';
  };

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    const preloadMark = async (mark: TTSMark)  => {
        const { language: voiceLang } = mark;
        const voiceId = await this.getVoiceIdFromLang(voiceLang);
        this.#currentVoiceId = voiceId;
        const key= hashPayload({text: mark.text, lang: voiceLang, voice: voiceId, rate: this.#rate});
        if (!HttpTTSClient.audioUrlCache.has(key)) {
            try {
            // console.log(`preloading: ${mark.text}`);

            const buf = await this.#provider.synthesize(mark.text, {
              lang: voiceLang,
              voice: voiceId,
              rate: this.#rate,
            });
            const audioBlob = new Blob([buf], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            HttpTTSClient.audioUrlCache.set(key,audioUrl);
            } catch (err) {
              console.warn('Error preloading mark', mark, err);
            }
        }
    }

    if (preload) {
      // Preload the first 2 marks immediately and the rest in the background
      const maxImmediate = 2;
      for (let i = 0; i < Math.min(maxImmediate, marks.length); i++) {
        if (signal.aborted) break;
        const mark = marks[i]!;
        preloadMark(mark);
      }
      if (marks.length > maxImmediate) {
        (async () => {
          for (let i = maxImmediate; i < marks.length; i++) {
            const mark = marks[i]!;
            preloadMark(mark);
          }
        })();
      }

      yield { code: 'end', message: 'Preload finished' } as TTSMessageEvent;
      return;
    }

    // TODO should stopinternal be called?
    // Just ensure audio element is ready
    if (!this.#audioElement) {
      this.#audioElement = new Audio();
    } else {
      // Reset audio element without clearing cache
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
      this.#audioElement.src = '';
    }
    const audio = this.#audioElement;
    audio.setAttribute('x-webkit-airplay', 'deny');
    audio.preload = 'auto';

    for (const mark of marks) {
      this.controller?.dispatchSpeakMark(mark);
      let abortHandler: null | (() => void) = null;
      try {
        const { language: voiceLang } = mark;
        const voiceId = await this.getVoiceIdFromLang(voiceLang);
        this.#speakingLang = voiceLang;

        // Synthesize audio via HTTP provider (use preload cache if available)
        const key = hashPayload({text: mark.text, lang: voiceLang, voice: voiceId, rate: this.#rate});
        let audioUrl = HttpTTSClient.audioUrlCache.get(key);
        if (!audioUrl) {
            // console.log(`loading ${mark.text}`);
            const audioBuffer = (await this.#provider.synthesize(mark.text, {
              lang: voiceLang,
              voice: voiceId,
              rate: this.#rate,
          })) as ArrayBuffer;
          const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
          audioUrl = URL.createObjectURL(audioBlob);
          HttpTTSClient.audioUrlCache.set(key, audioUrl);
        }

        if (signal.aborted) {
          yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
          break;
        }

        yield {
          code: 'boundary',
          message: `Start chunk: ${mark.name}`,
          mark: mark.name,
        } as TTSMessageEvent;

        const result = await new Promise<TTSMessageEvent>((resolve) => {
          const cleanUp = () => {
            audio.onended = null;
            audio.onerror = null;
            audio.src = '';
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
            resolve({ code: 'end', message: `Chunk finished: ${mark.name}` });
          };
          audio.onerror = (e) => {
            cleanUp();
            console.warn('Audio playback error:', e);
            resolve({ code: 'error', message: 'Audio playback error' });
          };
          this.#isPlaying = true;
          audio.src = audioUrl;
          // Rate adjustment handled by provider; keep audio at 1.0
          audio.playbackRate = 1.0;
          audio.play().catch((err) => {
            cleanUp();
            console.error('Failed to play audio:', err);
            resolve({ code: 'error', message: 'Playback failed: ' + err.message });
          });
        });
        yield result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('HTTP TTS error for mark:', mark.text, message);
        yield { code: 'error', message } as TTSMessageEvent;
        break;
      } finally {
        if (abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
    this.#isPlaying = false;
  }

  async pause(): Promise<boolean> {
    if (!this.#isPlaying || !this.#audioElement) return true;
    await this.#audioElement.pause();
    this.#isPlaying = false;
    return true;
  }

  async resume(): Promise<boolean> {
    if (!this.#audioElement) return false;
    try {
      await this.#audioElement.play().catch((err) => {
        console.error('Failed to resume audio:', err);
      });
      this.#isPlaying = true;
      return true;
    } catch (err) {
      // TODO superfluous catch?
      console.error('Failed to resume audio:', err);
      return false;
    }
  }

  async stop(): Promise<void> {
    await this.stopInternal();
  }

  private async stopInternal(): Promise<void> {
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.currentTime = 0;
      this.#audioElement.src = '';
    }
  }

  async setRate(rate: number): Promise<void> {
    this.#rate = rate;
  }

  async setPitch(_pitch: number): Promise<void> {
    // HTTP TTS provider doesn't support pitch adjustment
    // Silently ignore
  }

  async setVoice(voice: string): Promise<void> {
    const selectedVoice = this.#voices.find((v) => v.id === voice);
    if (selectedVoice) {
      this.#currentVoiceId = selectedVoice.id;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    this.#voices.forEach((voice) => {
      voice.disabled = !this.initialized;
    });
    return this.#voices;
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const voices = await this.getAllVoices();
    // Filter voices by language 
    const filteredVoices = voices.filter(
      (v) => v.lang === lang || v.lang === lang.split('-')[0],
    );

    return [
      {
        id: this.name,
        name: 'HTTP TTS',
        voices: filteredVoices.length > 0 ? filteredVoices : voices,
        disabled: !this.initialized || filteredVoices.length === 0,
      },
    ];
  }

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  getGranularities(): TTSGranularity[] {
    // Support sentence-level granularity
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }
}

export default HttpTTSClient;
