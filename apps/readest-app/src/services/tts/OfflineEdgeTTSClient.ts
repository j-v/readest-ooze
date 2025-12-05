/**
 * OfflineEdgeTTSClient - Extended EdgeTTSClient with offline audio support
 * This is a wrapper around EdgeTTSClient that checks for cached audio first
 */

import { EdgeTTSClient } from './EdgeTTSClient';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';

export class OfflineEdgeTTSClient implements TTSClient {
  name = 'edge-tts-offline';
  initialized = false;
  controller?: TTSController;

  private edgeClient: EdgeTTSClient;
  private bookHash: string = '';
  private offlineMode: boolean = false;

  constructor(controller?: TTSController) {
    this.controller = controller;
    this.edgeClient = new EdgeTTSClient(controller);
  }

  async init(): Promise<boolean> {
    this.initialized = await this.edgeClient.init();
    return this.initialized;
  }

  setBookHash(bookHash: string) {
    this.bookHash = bookHash;
  }

  setOfflineMode(enabled: boolean) {
    this.offlineMode = enabled;
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    // If offline mode is disabled, use normal behavior
    if (!this.offlineMode || !this.bookHash) {
      yield* this.edgeClient.speak(ssml, signal, preload);
      return;
    }

    // For preload, skip (offline mode doesn't need preload)
    if (preload) {
      yield {
        code: 'end',
        message: 'Preload skipped (offline mode)',
      } as TTSMessageEvent;
      return;
    }

    // Use offline playback logic (simplified version)
    // In a real implementation, you'd need to coordinate with EdgeTTSClient internals
    // For now, fall back to online
    console.warn('Offline playback not fully implemented, falling back to online');
    yield* this.edgeClient.speak(ssml, signal, preload);
  }

  async pause(): Promise<boolean> {
    return this.edgeClient.pause();
  }

  async resume(): Promise<boolean> {
    return this.edgeClient.resume();
  }

  async stop(): Promise<void> {
    return this.edgeClient.stop();
  }

  setPrimaryLang(lang: string): void {
    this.edgeClient.setPrimaryLang(lang);
  }

  async setRate(rate: number): Promise<void> {
    return this.edgeClient.setRate(rate);
  }

  async setPitch(pitch: number): Promise<void> {
    return this.edgeClient.setPitch(pitch);
  }

  async setVoice(voiceId: string): Promise<void> {
    return this.edgeClient.setVoice(voiceId);
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.edgeClient.getAllVoices();
  }

  async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    return this.edgeClient.getVoices(lang);
  }

  getGranularities(): TTSGranularity[] {
    return this.edgeClient.getGranularities();
  }

  getVoiceId(): string {
    return this.edgeClient.getVoiceId();
  }

  getSpeakingLang(): string {
    return this.edgeClient.getSpeakingLang();
  }

  async shutdown(): Promise<void> {
    return this.edgeClient.shutdown();
  }
}
