# TTS Provider Architecture

## Overview

The TTS provider architecture abstracts the audio generation logic from the offline audio management system, allowing the app to support multiple TTS engines without modifying the core download and playback logic.

## Architecture Components

### 1. TTSProvider Interface

Located at: `apps/readest-app/src/services/tts/providers/TTSProvider.ts`

The `TTSProvider` interface defines the contract that all TTS providers must implement:

```typescript
interface TTSProvider {
  readonly name: string;
  init(): Promise<boolean>;
  generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult>;
  getVoicesForLang(lang: string): Promise<string[]>;
  shutdown(): Promise<void>;
}
```

**Key methods:**
- `init()`: Initialize the TTS provider (e.g., load voices, verify API access)
- `generateAudio()`: Generate audio blob and duration from text and voice settings
- `getVoicesForLang()`: Get available voices for a specific language
- `shutdown()`: Clean up resources when switching providers

### 2. EdgeTTSProvider

Located at: `apps/readest-app/src/services/tts/providers/EdgeTTSProvider.ts`

The default implementation wrapping Microsoft Edge TTS:

```typescript
class EdgeTTSProvider implements TTSProvider {
  name = 'edge-tts';
  private edgeTTS: EdgeSpeechTTS;
  
  async generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult> {
    const response = await this.edgeTTS.create({
      lang: options.lang,
      text: options.text,
      voice: options.voiceId,
      rate: options.rate,
      pitch: options.pitch,
    });
    
    const audioBlob = new Blob([await response.arrayBuffer()], { type: 'audio/mpeg' });
    const duration = await getAudioDuration(audioBlob);
    
    return { audioBlob, duration };
  }
}
```

### 3. OfflineAudioManager Integration

Located at: `apps/readest-app/src/services/tts/OfflineAudioManager.ts`

The manager now accepts a provider and uses it for all audio generation:

```typescript
class OfflineAudioManager extends EventTarget {
  private ttsProvider: TTSProvider;

  constructor(provider?: TTSProvider) {
    super();
    this.ttsProvider = provider || new EdgeTTSProvider();
  }

  async setProvider(provider: TTSProvider): Promise<void> {
    // Clean up old provider
    await this.ttsProvider.shutdown();
    
    // Set and initialize new provider
    this.ttsProvider = provider;
    await provider.init();
  }
}
```

## Benefits

1. **Modularity**: Audio generation logic is separated from download management
2. **Extensibility**: Easy to add new TTS providers (e.g., native TTS, custom APIs)
3. **Testability**: Providers can be mocked for testing
4. **Flexibility**: Switch between providers at runtime
5. **Maintainability**: Changes to one TTS engine don't affect others

## Adding a New Provider

To add a new TTS provider:

1. Create a new class implementing `TTSProvider`:
   ```typescript
   export class CustomTTSProvider implements TTSProvider {
     readonly name = 'custom-tts';
     
     async init(): Promise<boolean> {
       // Initialize your TTS engine
       return true;
     }
     
     async generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult> {
       // Generate audio using your TTS engine
       const audioBlob = await yourTTSEngine.synthesize(options.text);
       const duration = await getAudioDuration(audioBlob);
       return { audioBlob, duration };
     }
     
     async getVoicesForLang(lang: string): Promise<string[]> {
       // Return available voices
       return yourTTSEngine.getVoices(lang);
     }
     
     async shutdown(): Promise<void> {
       // Clean up resources
     }
   }
   ```

2. Export from `providers/index.ts`:
   ```typescript
   export { CustomTTSProvider } from './CustomTTSProvider';
   ```

3. Use in OfflineAudioManager:
   ```typescript
   const customProvider = new CustomTTSProvider();
   const manager = new OfflineAudioManager(customProvider);
   await manager.init();
   ```

## Example Usage

```typescript
import { offlineAudioManager } from './OfflineAudioManager';
import { EdgeTTSProvider, CustomTTSProvider } from './providers';

// Default usage (EdgeTTS)
await offlineAudioManager.init();

// Switch to custom provider
const customProvider = new CustomTTSProvider();
await offlineAudioManager.setProvider(customProvider);

// Download with current provider
await offlineAudioManager.downloadBook({
  bookHash: 'book-123',
  bookDoc: bookDocument,
  voiceId: 'en-US-CustomVoice',
  rate: 1.0,
  pitch: 1.0,
  primaryLang: 'en',
});
```

## Future Providers

Potential future implementations:
- **NativeTTSProvider**: Use iOS/Android native TTS APIs
- **OpenAITTSProvider**: Use OpenAI's TTS API
- **GoogleTTSProvider**: Use Google Cloud TTS
- **AWSPollyProvider**: Use Amazon Polly
- **LocalTTSProvider**: Use browser's Web Speech API for free offline TTS

## Testing

Mock providers for testing:

```typescript
class MockTTSProvider implements TTSProvider {
  name = 'mock-tts';
  
  async generateAudio(options: TTSGenerationOptions): Promise<TTSAudioResult> {
    // Return dummy audio for testing
    const dummyBlob = new Blob(['test'], { type: 'audio/mpeg' });
    return { audioBlob: dummyBlob, duration: 1000 };
  }
  
  // ... other methods
}
```

## Performance Considerations

- **Initialization**: Providers should initialize quickly or support lazy loading
- **Memory**: Large voice models should be loaded on-demand
- **Caching**: Providers can implement internal caching for frequently used phrases
- **Error handling**: Providers should gracefully handle network errors and rate limits

## Security Considerations

- **API keys**: Store securely, never commit to source code
- **Rate limiting**: Implement provider-specific rate limiting
- **Data privacy**: Be aware of what data is sent to third-party APIs
- **Offline support**: Some providers may require network access
