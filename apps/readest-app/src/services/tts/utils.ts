/**
 * Utility functions for TTS offline audio processing
 */

/**
 * Extract audio duration from a blob by loading it into an Audio element
 * @param blob Audio blob (e.g., MPEG, WAV)
 * @returns Duration in milliseconds
 */
export async function getAudioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);

    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.remove();
    };

    audio.addEventListener('loadedmetadata', () => {
      const duration = audio.duration * 1000; // convert to ms
      cleanup();
      resolve(duration);
    });

    audio.addEventListener('error', (e) => {
      cleanup();
      reject(new Error(`Failed to load audio metadata: ${e}`));
    });

    audio.src = url;
    audio.load();
  });
}

/**
 * Simple hash function for content validation
 * @param text Text content to hash
 * @returns Hash string
 */
export function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
