# HTTP TTS Setup Guide

This guide explains how to enable and use the custom HTTP TTS client in Readest.

## Overview

The HTTP TTS client allows you to connect to a custom TTS endpoint instead of using built-in Edge TTS, Web Speech, or Native TTS. This is useful for:

- Using custom voice models
- Running a local TTS server
- Connecting to a private TTS API

## Setup

### 2. Configure the TTS Endpoint

### 3. TTS Server API Requirements

Your TTS server must accept POST requests with the following JSON body:

```json
{
  "text": "The text to synthesize",
  "voice": "af_bella",
  "speed": 1.0
}
```

And return audio data (typically MP3 format) as a binary response.

### 4. Configure Available Voices

To add more voices beyond the default `af_bella`, edit the voice list in `HttpTTSClient.ts` constructor:

```typescript
this.#voices = [
  {
    id: 'af_bella',
    name: 'Bella',
    lang: 'en',
  },
  {
    id: 'your-voice-id',
    name: 'Your Voice Name',
    lang: 'en', // or 'es', 'fr', etc.
  },
];
```

## Usage

1. Start the Readest app in development mode:

   ```bash
   pnpm dev-web
   ```

2. Open a book and click the TTS button

3. Click the voice icon in the TTS control panel

4. Select "Bella" from the "HTTP TTS" section

5. Click play to start reading with your custom TTS voice

## Troubleshooting

### Voice Not Appearing

- Verify `NEXT_PUBLIC_ENABLE_HTTP_TTS=true` is set in your `.env` file
- Restart the development server after changing environment variables

### Connection Errors

- Ensure your TTS server is running and accessible
- Check the endpoint URL in `HttpTTSClient.ts`
- Check browser console for error messages

### Playback Issues

- Verify your TTS server returns valid audio data (MP3 format recommended)
- Check that the `Content-Type` header is set correctly on the server response
- Increase `timeoutMs` if synthesis is slow

## Architecture

The HTTP TTS client follows the same architecture as other TTS clients:

1. **HttpTTSProvider** (`src/services/tts/providers/HttpTTSProvider.ts`):

   - Handles HTTP communication with the TTS server
   - Implements the TTSProvider interface

2. **HttpTTSClient** (`src/services/tts/HttpTTSClient.ts`):

   - Wraps the HttpTTSProvider
   - Implements the TTSClient interface
   - Handles SSML parsing, audio playback, and mark synchronization

3. **TTSController** (`src/services/tts/TTSController.ts`):
   - Manages all TTS clients
   - Routes voice selection to the appropriate client

## Feature Flag

The HTTP TTS client is disabled by default and requires the `NEXT_PUBLIC_ENABLE_HTTP_TTS` environment variable to be explicitly set to `true`. This prevents accidental exposure of custom endpoints in production builds.
