import TTSProvider, { SynthesizeOptions } from './TTSProvider';

export interface HttpTTSProviderOptions {
  endpoint: string;
  timeoutMs?: number;
}

interface HttpTTSRequestBody {
  text: string;
  voice: string;
  speed: number;
}

export class HttpTTSProvider implements TTSProvider {
  id = 'http-tts';
  capabilities = { supportsRate: true, supportsPitch: false, supportsStreaming: true };
  private endpoint: string;
  private timeoutMs: number | undefined;

  constructor(opts: HttpTTSProviderOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs;
  }

  async init(): Promise<void> {
    // no-op
  }

  async dispose(): Promise<void> {
    // no-op
  }

  async synthesize(text: string, options: SynthesizeOptions): Promise<ArrayBuffer> {
    const body: HttpTTSRequestBody = {
      text,
      voice: options.voice,
      speed: options.rate ?? 1.0,
    };

    const controller = this.timeoutMs ? new AbortController() : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs && controller) {
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    }

    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });

    if (timeout) clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`HTTP TTS request failed: ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return arrayBuffer;
  }
}

export default HttpTTSProvider;
