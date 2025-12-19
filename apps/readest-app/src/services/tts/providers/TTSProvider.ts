/**
 * TTSProvider - Abstract interface for TTS audio generation
 * Allows OfflineAudioManager to work with different TTS engines
 */

export interface TTSAudioResult {
  audioBlob: Blob;
  duration: number; // in milliseconds
}

export interface TTSGenerationOptions {
  lang: string;
  text: string;
  voiceId: string;
  rate: number;
  pitch: number;
}

/**
 * Abstract interface for TTS providers
 * Implementations handle the specifics of generating audio from text
 */
export interface TTSProvider {
  /**
   * Name of the provider (e.g., 'edge-tts', 'native-tts')
   */
  readonly name: string;

  /**
   * Initialize the provider
   * @returns true if initialization successful
   */
  init(): Promise<boolean>;

  /**
   * Generate audio for the given text
   * @param options - TTS generation options
   * @returns Audio blob and duration
   */
  generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult>;

  /**
   * Get available voices for a language
   * @param lang - Language code
   * @returns Array of voice IDs
   */
  getVoicesForLang(lang: string): Promise<string[]>;

  /**
   * Cleanup resources
   */
  shutdown(): Promise<void>;
}
