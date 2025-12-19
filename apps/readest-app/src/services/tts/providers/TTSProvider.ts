import { TTSGranularity } from '../types';

export type SynthesizeOptions = {
  lang: string;
  voice: string;
  rate?: number;
  pitch?: number;
  granularity?: TTSGranularity;
  targetLang?: string;
};

export type ProviderCapabilities = {
  supportsRate?: boolean;
  supportsPitch?: boolean;
  supportsStreaming?: boolean;
};

export interface TTSProvider {
  id: string;
  capabilities: ProviderCapabilities;
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  /**
   * Synthesize text and return an ArrayBuffer or Blob
   */
  synthesize(text: string, options: SynthesizeOptions): Promise<ArrayBuffer | Blob>;
}

export default TTSProvider;
