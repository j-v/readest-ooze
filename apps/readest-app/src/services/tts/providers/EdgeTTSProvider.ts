import TTSProvider, { SynthesizeOptions } from './TTSProvider';
import { EdgeSpeechTTS } from '@/libs/edgeTTS';

export class EdgeTTSProvider implements TTSProvider {
  id = 'edge-tts';
  capabilities = { supportsRate: true, supportsPitch: true, supportsStreaming: false };
  private edge: EdgeSpeechTTS;

  constructor(edge?: EdgeSpeechTTS) {
    this.edge = edge || new EdgeSpeechTTS();
  }

  async init(): Promise<void> {
    // no-op for now, but keep for future
  }

  async dispose(): Promise<void> {
    // no-op
  }

  async synthesize(text: string, options: SynthesizeOptions): Promise<ArrayBuffer> {
    // Map options to edgeTTS API
    const resp = await this.edge.create({
      lang: options.lang,
      text,
      voice: options.voice,
      rate: options.rate ?? 1.0,
      pitch: options.pitch ?? 1.0,
    });

    const buffer = await resp.arrayBuffer();
    return buffer;
  }
}

export default EdgeTTSProvider;
