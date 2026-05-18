import { FoliateView } from '@/types/view';
import { AppService } from '@/types/system';
import { filterSSMLWithLang, parseSSMLMarks } from '@/utils/ssml';
import { Overlayer } from 'foliate-js/overlayer.js';
import { TTSGranularity, TTSHighlightOptions, TTSMark, TTSVoice } from './types';
import { createRejectFilter } from '@/utils/node';
import { WebSpeechClient } from './WebSpeechClient';
import { NativeTTSClient } from './NativeTTSClient';
import { EdgeTTSClient } from './EdgeTTSClient';
import { OfflineTTSClient } from './OfflineTTSClient';
import { HttpTTSClient } from './HttpTTSClient';
import { TTSUtils } from './TTSUtils';
import { TTSClient } from './TTSClient';
import { useSettingsStore } from '@/store/settingsStore';
import { isValidLang } from '@/utils/lang';

type TTSState =
  | 'stopped'
  | 'playing'
  | 'paused'
  | 'stop-paused'
  | 'backward-paused'
  | 'forward-paused'
  | 'setrate-paused'
  | 'setvoice-paused';

const HIGHLIGHT_KEY = 'tts-highlight';

export class TTSController extends EventTarget {
  appService: AppService | null = null;
  view: FoliateView;
  isAuthenticated: boolean = false;
  preprocessCallback?: (ssml: string) => Promise<string>;
  onSectionChange?: (sectionIndex: number) => Promise<void>;
  #nossmlCnt: number = 0;
  #currentSpeakAbortController: AbortController | null = null;
  #currentSpeakPromise: Promise<void> | null = null;

  #ttsSectionIndex: number = -1;

  state: TTSState = 'stopped';
  ttsLang: string = '';
  ttsRate: number = 1.0;
  ttsClient: TTSClient;
  ttsWebClient: TTSClient;
  ttsEdgeClient: TTSClient;
  ttsOfflineClient: TTSClient;
  ttsNativeClient: TTSClient | null = null;
  ttsHttpClient: TTSClient | null = null;
  ttsWebVoices: TTSVoice[] = [];
  ttsEdgeVoices: TTSVoice[] = [];
  ttsNativeVoices: TTSVoice[] = [];
  ttsHttpVoices: TTSVoice[] = [];
  ttsTargetLang: string = '';

  // Context tracking for offline TTS
  #bookHash: string = '';
  #lastSectionHref: string = '';
  #lastContentIndex: number = -1;
  #voiceId: string = '';

  options: TTSHighlightOptions = { style: 'highlight', color: 'gray' };

  constructor(
    appService: AppService | null,
    view: FoliateView,
    isAuthenticated: boolean = false,
    preprocessCallback?: (ssml: string) => Promise<string>,
    onSectionChange?: (sectionIndex: number) => Promise<void>,
  ) {
    super();
    this.ttsWebClient = new WebSpeechClient(this);
    this.ttsEdgeClient = new EdgeTTSClient(this, appService);
    this.ttsOfflineClient = new OfflineTTSClient(this);
    // TODO: implement native TTS client for iOS and PC
    if (appService?.isAndroidApp) {
      this.ttsNativeClient = new NativeTTSClient(this);
    }
    // Initialize HTTP TTS client if enabled in settings
    const settings = useSettingsStore.getState().settings;
    if (settings.customTTSEndpoint?.enabled) {
      this.ttsHttpClient = new HttpTTSClient(
        this,
        settings.customTTSEndpoint?.endpoint ?? 'http://localhost:8000/tts',
      );
    }
    this.ttsClient = this.ttsWebClient;
    this.appService = appService;
    this.view = view;
    this.isAuthenticated = isAuthenticated;
    this.preprocessCallback = preprocessCallback;
    this.onSectionChange = onSectionChange;
  }

  async init(bookHash?: string, sectionHref?: string, voiceId?: string, lang?: string) {
    // Always initialize offline client first (lightweight, no network calls)
    await this.ttsOfflineClient.init();

    // Store context for offline TTS updates during playback
    if (bookHash) this.#bookHash = bookHash;
    if (sectionHref) this.#lastSectionHref = sectionHref;
    if (voiceId) this.#voiceId = voiceId;

    // Check if offline audio is available BEFORE initializing any online clients
    if (bookHash && sectionHref) {
      try {
        if (!this.ttsOfflineClient.setContext) {
          console.warn('Offline TTS client does not support setContext');
        } else {
          this.ttsOfflineClient.setContext(bookHash, sectionHref, voiceId ?? '', lang);
          const hasOfflineAudio = await (
            this.ttsOfflineClient as OfflineTTSClient
          ).hasOfflineAudio();

          if (hasOfflineAudio) {
            // Offline audio is available - skip all online initialization!
            this.ttsClient = this.ttsOfflineClient;
            await this.ttsClient.setRate(this.ttsRate);
            this.dispatchClientChange();
            console.log('Using offline TTS - skipping online client initialization');
            return;
          }
        }
      } catch (error) {
        console.warn('Error checking offline audio, falling back to online:', error);
        // Continue to online initialization on error
      }
    }

    // Initialize online clients only if offline audio is not available
    const availableClients = [];

    if (await this.ttsEdgeClient.init()) {
      availableClients.push(this.ttsEdgeClient);
    }
    if (this.ttsNativeClient && (await this.ttsNativeClient.init())) {
      availableClients.push(this.ttsNativeClient);
      this.ttsNativeVoices = await this.ttsNativeClient.getAllVoices();
    }
    if (this.ttsHttpClient && (await this.ttsHttpClient.init())) {
      availableClients.push(this.ttsHttpClient);
      this.ttsHttpVoices = await this.ttsHttpClient.getAllVoices();
    }
    if (await this.ttsWebClient.init()) {
      availableClients.push(this.ttsWebClient);
    }
    this.ttsClient = availableClients[0] || this.ttsWebClient;
    const preferredClientName = TTSUtils.getPreferredClient();
    if (preferredClientName) {
      const preferredClient = availableClients.find(
        (client) => client.name === preferredClientName,
      );
      if (preferredClient) {
        this.ttsClient = preferredClient;
      }
    }
    this.dispatchClientChange();
    this.ttsWebVoices = await this.ttsWebClient.getAllVoices();
    this.ttsEdgeVoices = await this.ttsEdgeClient.getAllVoices();
  }

  #getPrimaryContent() {
    const contents = this.view.renderer.getContents();
    const primaryIndex = this.view.renderer.primaryIndex;
    return (contents.find((x) => x.index === primaryIndex) ?? contents[0]) as
      | {
          doc: Document;
          index?: number;
          overlayer?: Overlayer;
        }
      | undefined;
  }

  #getHighlighter() {
    return (range: Range) => {
      const content = this.#getPrimaryContent();
      if (!content) return;
      const { doc, index, overlayer } = content;
      if (!doc || index === undefined || index !== this.#ttsSectionIndex) {
        return;
      }
      try {
        const cfi = this.view.getCFI(index, range);
        const visibleRange = this.view.resolveCFI(cfi).anchor(doc);
        const { style, color } = this.options;
        overlayer?.remove(HIGHLIGHT_KEY);
        overlayer?.add(HIGHLIGHT_KEY, visibleRange, Overlayer[style], { color });
      } catch (e) {
        console.error('Failed to highlight range', e);
      }
    };
  }

  #clearHighlighter() {
    const content = this.#getPrimaryContent();
    const overlayer = content?.overlayer as Overlayer | undefined;
    overlayer?.remove(HIGHLIGHT_KEY);
  }

  /**
   * Try to use offline audio playback if available, otherwise keep using active TTS client
   * This method should be called before speak() when offline audio might be available
   * Returns true if switched to offline mode, false otherwise
   */
  async tryUseOfflineAudio(
    bookHash: string,
    sectionHref: string,
    voiceId: string,
    lang?: string,
  ): Promise<boolean> {
    if (!this.ttsOfflineClient.setContext || !this.ttsOfflineClient.initialized) {
      return false;
    }

    // Set context then check if audio is available
    this.ttsOfflineClient.setContext(bookHash, sectionHref, voiceId, lang);

    const hasAudio = await (this.ttsOfflineClient as OfflineTTSClient).hasOfflineAudio();

    if (hasAudio) {
      this.ttsClient = this.ttsOfflineClient;
      await this.ttsClient.setRate(this.ttsRate);
      this.dispatchClientChange();
      console.log('Switched to offline TTS - audio available for section');
      return true;
    }

    console.log('Offline audio not available, using online TTS');
    return false;
  }

  /**
   * Update offline TTS context if the current section has changed.
   * This should be called before speak() when using offline TTS to handle chapter transitions.
   * Returns true if offline audio is available for the new section.
   */
  async updateOfflineContextIfNeeded(): Promise<boolean> {
    if (this.ttsClient.name !== 'offline-tts' || !this.ttsOfflineClient.setContext) {
      return true;
    }

    let currentHref = '';
    const contents = this.view.renderer.getContents();
    const contentIndex = contents[0]?.index;
    if (typeof contentIndex === 'number') {
      currentHref = this.view.book?.sections?.[contentIndex]?.id || '';
    }

    if (!currentHref || currentHref === this.#lastSectionHref) {
      return true;
    }

    // When TTS auto-advances to the next spine section, the renderer's
    // content index may still point to the previous section (hasn't caught
    // up yet). Don't revert the offline context in that case — the
    // correct context was already set by #initTTSForSection.
    if (typeof contentIndex === 'number' && contentIndex === this.#lastContentIndex - 1) {
      return true;
    }

    const prevHref = this.#lastSectionHref;
    this.#lastSectionHref = currentHref;
    if (typeof contentIndex === 'number') {
      this.#lastContentIndex = contentIndex;
    }

    console.log('[TTSController] Section transition detected:', {
      from: prevHref,
      to: currentHref,
      contentIndex,
    });

    this.ttsOfflineClient.setContext(this.#bookHash, currentHref, this.#voiceId, this.ttsLang);

    const hasAudio = await (this.ttsOfflineClient as OfflineTTSClient).hasOfflineAudio();

    if (!hasAudio) {
      console.log('[TTSController] No offline audio for new section, switching to online');
      await this.disableOfflineAudio();
      return false;
    }

    console.log('[TTSController] Offline audio available for new section');
    return true;
  }

  /**
   * Revert to the primary TTS client (not offline)
   */
  async disableOfflineAudio(): Promise<void> {
    if (this.ttsClient.name === 'offline-tts') {
      const preferredClientName = TTSUtils.getPreferredClient();
      if (preferredClientName === 'native-tts' && this.ttsNativeClient?.initialized) {
        this.ttsClient = this.ttsNativeClient;
      } else if (preferredClientName === 'edge-tts' && this.ttsEdgeClient.initialized) {
        this.ttsClient = this.ttsEdgeClient;
      } else if (this.ttsEdgeClient.initialized) {
        this.ttsClient = this.ttsEdgeClient;
      } else {
        this.ttsClient = this.ttsWebClient;
      }
      await this.ttsClient.setRate(this.ttsRate);
      this.dispatchClientChange();
      console.log('Switched back to online TTS:', this.ttsClient.name);
    }
  }

  updateHighlightOptions(options: TTSHighlightOptions) {
    this.options.style = options.style;
    this.options.color = options.color;
  }

  async initViewTTS(index?: number) {
    if (this.#ttsSectionIndex === -1) {
      const fromSectionIndex = (index || this.#getPrimaryContent()?.index) ?? 0;
      await this.#initTTSForSection(fromSectionIndex);
    }
  }

  async #initTTSForSection(sectionIndex: number): Promise<boolean> {
    const sections = this.view.book.sections;
    if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
      return false;
    }

    const section = sections[sectionIndex];
    if (!section?.createDocument) {
      return false;
    }

    this.#ttsSectionIndex = sectionIndex;

    const currentSection = this.#getPrimaryContent();
    if (currentSection?.index !== sectionIndex) {
      await this.onSectionChange?.(sectionIndex);
    }

    let doc: Document;
    let docSource: 'rendered' | 'fresh';
    if (currentSection?.index === sectionIndex && currentSection?.doc) {
      doc = currentSection.doc;
      docSource = 'rendered';
    } else {
      doc = await section.createDocument();
      docSource = 'fresh';
      const html = doc.querySelector('html');
      const lang = html?.getAttribute('lang') || html?.getAttribute('xml:lang') || '';
      if (html && !isValidLang(lang) && this.ttsLang) {
        html.setAttribute('lang', this.ttsLang);
        html.setAttribute('xml:lang', this.ttsLang);
      }
    }

    if (this.view.tts && this.view.tts.doc === doc) {
      return true;
    }

    const { TTS } = await import('foliate-js/tts.js');
    const { textWalker } = await import('foliate-js/text-walker.js');
    let granularity: TTSGranularity = this.view.language.isCJK ? 'sentence' : 'word';
    const supportedGranularities = this.ttsClient.getGranularities();
    if (!supportedGranularities.includes(granularity)) {
      granularity = supportedGranularities[0]!;
    }

    this.view.tts = new TTS(
      doc,
      textWalker,
      createRejectFilter({
        tags: ['rt', 'canvas', 'br'],
        classes: ['annotationLayer'],
        contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
      }),
      this.#getHighlighter(),
      granularity,
    );
    console.log(`[TTS] Initialized TTS for section ${sectionIndex}`, {
      sectionId: section.id,
      docSource,
      granularity,
    });

    // Update offline context using the actual section id (not the renderer's content index,
    // which may lag behind when TTS auto-advances between sections).
    if (this.ttsClient.name === 'offline-tts' && this.ttsOfflineClient.setContext) {
      const newHref = section.id || '';
      if (newHref && newHref !== this.#lastSectionHref) {
        this.#lastSectionHref = newHref;
        this.#lastContentIndex = sectionIndex;
        this.ttsOfflineClient.setContext(this.#bookHash, newHref, this.#voiceId, this.ttsLang);
        const hasAudio = await (this.ttsOfflineClient as OfflineTTSClient).hasOfflineAudio();
        if (!hasAudio) {
          console.log('[TTSController] No offline audio for section, switching to online');
          await this.disableOfflineAudio();
        }
      }
    }

    return true;
  }

  async #initTTSForNextSection(): Promise<boolean> {
    const nextIndex = this.#ttsSectionIndex + 1;
    const sections = this.view.book.sections;

    if (!sections || nextIndex >= sections.length) {
      return false;
    }

    return await this.#initTTSForSection(nextIndex);
  }

  async #initTTSForPrevSection(): Promise<boolean> {
    const prevIndex = this.#ttsSectionIndex - 1;

    if (prevIndex < 0) {
      return false;
    }

    return await this.#initTTSForSection(prevIndex);
  }

  async #handleNavigationWithSSML(ssml: string | undefined, isPlaying: boolean) {
    if (isPlaying) {
      this.#speak(ssml);
    } else {
      if (ssml) {
        const { marks } = parseSSMLMarks(ssml);
        if (marks.length > 0) {
          this.dispatchSpeakMark(marks[0]);
        }
      }
    }
  }

  async #handleNavigationWithoutSSML(initSection: () => Promise<boolean>, isPlaying: boolean) {
    if (await initSection()) {
      if (isPlaying) {
        this.#speak(this.view.tts?.start());
      } else {
        this.view.tts?.start();
      }
    } else {
      await this.stop();
    }
  }

  async preloadSSML(ssml: string | undefined, signal: AbortSignal) {
    if (!ssml) return;
    const iter = await this.ttsClient.speak(ssml, signal, true);
    for await (const _ of iter);
  }

  async preloadNextSSML(count: number = 4) {
    // Simple fix for offline TTS jumping highlight to preloaded paragraph, may be masking an underlying race condition
    // between preloadNextSSML() and speak() accessing this.view.tts
    if (this.ttsClient.name === 'offline-tts') return;

    const tts = this.view.tts;
    if (!tts) return;

    // Gather all next SSMLs and rewind synchronously to avoid a race condition:
    // tts.next() replaces TTS.#ranges (used by setMark() during playback).
    // If async gaps exist between next()/prev() calls, a concurrent #speak()
    // can dispatch marks against the wrong #ranges, causing incorrect highlights
    // and accidental page turns.
    const rawSsmls: string[] = [];
    for (let i = 0; i < count; i++) {
      const ssml = tts.next();
      if (!ssml) break;
      rawSsmls.push(ssml);
    }
    for (let i = 0; i < rawSsmls.length; i++) {
      tts.prev();
    }

    const ssmls: string[] = [];
    for (const raw of rawSsmls) {
      const ssml = await this.#preprocessSSML(raw);
      if (!ssml) break;
      ssmls.push(ssml);
    }
    await Promise.all(ssmls.map((ssml) => this.preloadSSML(ssml, new AbortController().signal)));
  }

  async #preprocessSSML(ssml?: string) {
    if (!ssml) return;
    ssml = ssml
      .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
      .replace(/[–—]/g, ',')
      .replace('<break/>', ' ')
      .replace(/\.{3,}/g, '   ')
      .replace(/……/g, '  ')
      .replace(/\*/g, ' ')
      .replace(/·/g, ' ');

    if (this.ttsTargetLang) {
      ssml = filterSSMLWithLang(ssml, this.ttsTargetLang);
    }

    if (this.preprocessCallback && ssml) {
      ssml = await this.preprocessCallback(ssml);
    }

    return ssml;
  }

  async #speak(ssml: string | undefined | Promise<string>, oneTime = false) {
    await this.stop();
    this.#currentSpeakAbortController = new AbortController();
    const speakAbortController = this.#currentSpeakAbortController;
    const { signal } = this.#currentSpeakAbortController;

    // Track if we're using offline TTS for fallback handling
    const isUsingOffline = this.ttsClient.name === 'offline-tts';

    // Update offline context if section changed (handles chapter transitions)
    if (isUsingOffline) {
      await this.updateOfflineContextIfNeeded();
    }

    this.#currentSpeakPromise = new Promise(async (resolve, reject) => {
      try {
        console.log('[TTS] speak');
        this.state = 'playing';

        signal.addEventListener('abort', () => {
          resolve();
        });

        ssml = await this.#preprocessSSML(await ssml);
        if (!ssml) {
          this.#nossmlCnt++;
          // FIXME: in case we are at the end of the book, need a better way to handle this
          if (this.#nossmlCnt < 10 && this.state === 'playing' && !oneTime) {
            resolve();
            if (await this.#initTTSForNextSection()) {
              await this.forward();
            } else {
              await this.stop();
            }
          }
          console.log('[TTS] no SSML, skipping for', this.#nossmlCnt);
          return;
        } else {
          this.#nossmlCnt = 0;
        }

        const { plainText, marks } = parseSSMLMarks(ssml);
        if (!oneTime) {
          if (!plainText || marks.length === 0) {
            resolve();
            return await this.forward();
          } else {
            this.dispatchSpeakMark(marks[0]);
          }
          await this.preloadSSML(ssml, signal);
        }
        const iter = await this.ttsClient.speak(ssml, signal);
        let lastCode;
        for await (const { code } of iter) {
          if (signal.aborted) {
            resolve();
            return;
          }
          lastCode = code;
        }

        if (lastCode === 'end' && this.state === 'playing' && !oneTime) {
          resolve();
          await this.forward();
        }
        resolve();
      } catch (e) {
        // If offline TTS fails, automatically fall back to online TTS
        if (isUsingOffline && !signal.aborted) {
          console.warn('Offline TTS failed, falling back to online:', e);
          try {
            await this.disableOfflineAudio();
            console.log('Switched to online TTS after offline failure');
            // Re-initialize online clients if needed
            if (!this.ttsEdgeClient.initialized && !this.ttsWebClient.initialized) {
              console.log('Initializing online clients for fallback...');
              if (await this.ttsEdgeClient.init()) {
                this.ttsClient = this.ttsEdgeClient;
              } else if (await this.ttsWebClient.init()) {
                this.ttsClient = this.ttsWebClient;
              }
              await this.ttsClient.setRate(this.ttsRate);
            }
            // Retry with online client
            resolve();
            await this.forward();
            return;
          } catch (fallbackError) {
            console.error('Failed to fall back to online TTS:', fallbackError);
          }
        }

        if (signal.aborted) {
          resolve();
        } else {
          reject(e);
        }
      } finally {
        // Only clean up if we are still the current controller
        if (this.#currentSpeakAbortController === speakAbortController) {
          this.#currentSpeakAbortController.abort();
          this.#currentSpeakAbortController = null;
        }
      }
    });

    await this.#currentSpeakPromise.catch((e) => this.error(e));
  }

  async speak(ssml: string | Promise<string>, oneTime = false, oneTimeCallback?: () => void) {
    await this.initViewTTS();
    this.#speak(ssml, oneTime)
      .then(() => {
        if (oneTime && oneTimeCallback) {
          oneTimeCallback();
        }
      })
      .catch((e) => this.error(e));
    if (!oneTime) {
      this.preloadNextSSML();
      this.dispatchSpeakMark();
    }
  }

  play() {
    if (this.state !== 'playing') {
      this.start();
    } else {
      this.pause();
    }
  }

  async start() {
    await this.initViewTTS();
    // Always resume from the current list position instead of calling tts.start().
    // tts.start() resets the TTS list to position 0 (section beginning), which is
    // wrong when state transiently becomes 'stopped' during forward()/backward()
    // — a fast play tap in that window would otherwise jump back to section start.
    // tts.resume() falls back to tts.next() on a fresh TTS, so it's safe at init.
    const ssml = this.view.tts?.resume();
    if (this.state.includes('paused')) {
      this.resume();
    }
    this.#speak(ssml);
    this.preloadNextSSML();
  }

  async pause() {
    this.state = 'paused';
    if (!(await this.ttsClient.pause().catch((e) => this.error(e)))) {
      await this.stop();
      this.state = 'stop-paused';
    }
  }

  async resume() {
    this.state = 'playing';
    await this.ttsClient.resume().catch((e) => this.error(e));
  }

  async stop() {
    if (this.#currentSpeakAbortController) {
      this.#currentSpeakAbortController.abort();
    }
    await this.ttsClient.stop().catch((e) => this.error(e));

    if (this.#currentSpeakPromise) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stop operation timed out')), 3000),
      );
      await Promise.race([this.#currentSpeakPromise.catch((e) => this.error(e)), timeout]).catch(
        (e) => this.error(e),
      );
      this.#currentSpeakPromise = null;
    }
    this.state = 'stopped';
  }

  // goto previous mark/paragraph
  async backward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop();
    if (!isPlaying) this.state = 'backward-paused';

    const ssml = byMark ? this.view.tts?.prevMark(!isPlaying) : this.view.tts?.prev(!isPlaying);
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForPrevSection(), isPlaying);
    } else {
      await this.#handleNavigationWithSSML(ssml, isPlaying);
    }
  }

  // goto next mark/paragraph
  async forward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop();
    if (!isPlaying) this.state = 'forward-paused';

    const ssml = byMark ? this.view.tts?.nextMark(!isPlaying) : this.view.tts?.next(!isPlaying);
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForNextSection(), isPlaying);
    } else {
      await this.#handleNavigationWithSSML(ssml, isPlaying);
    }
    if (isPlaying && !byMark) this.preloadNextSSML();
  }

  async setLang(lang: string) {
    this.ttsLang = lang;
    this.setPrimaryLang(lang);
  }

  async setPrimaryLang(lang: string) {
    if (this.ttsEdgeClient.initialized) this.ttsEdgeClient.setPrimaryLang(lang);
    if (this.ttsWebClient.initialized) this.ttsWebClient.setPrimaryLang(lang);
    if (this.ttsNativeClient?.initialized) this.ttsNativeClient?.setPrimaryLang(lang);
    // TODO add for http client?
  }

  async setRate(rate: number) {
    this.state = 'setrate-paused';
    this.ttsRate = rate;
    await this.ttsClient.setRate(this.ttsRate);
  }

  async getVoices(lang: string) {
    const ttsWebVoices = await this.ttsWebClient.getVoices(lang);
    const ttsEdgeVoices = await this.ttsEdgeClient.getVoices(lang);
    const ttsNativeVoices = (await this.ttsNativeClient?.getVoices(lang)) ?? [];
    const ttsHttpVoices = (await this.ttsHttpClient?.getVoices(lang)) ?? [];

    const voicesGroups = [...ttsNativeVoices, ...ttsHttpVoices, ...ttsEdgeVoices, ...ttsWebVoices];
    return voicesGroups;
  }

  async setVoice(voiceId: string, lang: string) {
    this.state = 'setvoice-paused';
    const useEdgeTTS = !!this.ttsEdgeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    const useNativeTTS = !!this.ttsNativeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    const useHttpTTS = !!this.ttsHttpVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    if (useEdgeTTS) {
      this.ttsClient = this.ttsEdgeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else if (useNativeTTS) {
      if (!this.ttsNativeClient) {
        throw new Error('Native TTS client is not available');
      }
      this.ttsClient = this.ttsNativeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else if (useHttpTTS) {
      if (!this.ttsHttpClient) {
        throw new Error('HTTP TTS client is not available');
      }
      this.ttsClient = this.ttsHttpClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else {
      this.ttsClient = this.ttsWebClient;
      await this.ttsClient.setRate(this.ttsRate);
    }
    TTSUtils.setPreferredClient(this.ttsClient.name);
    TTSUtils.setPreferredVoice(this.ttsClient.name, lang, voiceId);
    this.dispatchClientChange();
    await this.ttsClient.setVoice(voiceId);
  }

  getVoiceId() {
    return this.ttsClient.getVoiceId();
  }

  getSpeakingLang() {
    return this.ttsClient.getSpeakingLang();
  }

  setTargetLang(lang: string) {
    this.ttsTargetLang = lang;
  }

  dispatchSpeakMark(mark?: TTSMark) {
    this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: mark || { text: '' } }));
    if (mark && mark.name !== '-1') {
      try {
        const range = this.view.tts?.setMark(mark.name);
        const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
        this.dispatchEvent(new CustomEvent('tts-highlight-mark', { detail: { cfi } }));
      } catch {}
    }
  }

  dispatchClientChange() {
    this.dispatchEvent(
      new CustomEvent('tts-client-change', {
        detail: {
          clientName: this.ttsClient.name,
          isOffline: this.ttsClient.name === 'offline-tts',
        },
      }),
    );
  }

  error(e: unknown) {
    // AbortError is expected during normal stop/restart cycles (rate change,
    // forward/backward, voice change) — on iOS especially, the in-flight
    // audio.play() promise rejects with AbortError after audio.src is reset,
    // and that rejection can leak through one of the .catch chains. Letting it
    // flip state to 'stopped' desyncs the state machine: handleSetRate's
    // `state === 'playing'` check then falls through to a no-op, and #speak's
    // auto-forward gate skips advancing to the next paragraph.
    if (e instanceof Error && (e.name === 'AbortError' || e.message === 'Aborted')) {
      return;
    }
    console.error(e);
    this.state = 'stopped';
  }

  async shutdown() {
    await this.stop();
    this.#clearHighlighter();
    if (this.ttsOfflineClient.initialized) {
      await this.ttsOfflineClient.shutdown();
    }
    this.#ttsSectionIndex = -1;
    this.view.tts = null;
    if (this.ttsWebClient.initialized) {
      await this.ttsWebClient.shutdown();
    }
    if (this.ttsEdgeClient.initialized) {
      await this.ttsEdgeClient.shutdown();
    }
    if (this.ttsNativeClient?.initialized) {
      await this.ttsNativeClient.shutdown();
    }
  }
}
