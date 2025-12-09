/**
 * OfflineAudioStorage - IndexedDB-based storage for downloaded TTS audio
 * Stores audio blobs with metadata to enable offline playback
 */

export interface OfflineAudioRecord {
  id: string; // composite key: `${bookHash}:${href}:${voiceId}`
  bookHash: string;
  href: string; // TOC href/section identifier
  voiceId: string;
  audioBlob: Blob;
  rate: number;
  pitch: number;
  text: string; // original text for regeneration if needed
  ssml: string; // processed SSML
  downloadedAt: number;
  size: number; // blob size in bytes
}

export interface MarkTimingInfo {
  name: string; // mark name from SSML (e.g., "0", "1", "2")
  text: string; // the actual text content
  language: string; // language for this mark
  offset: number; // character offset in plain text
  audioOffset: number; // time offset in audio (ms)
  duration: number; // duration of this mark's audio (ms)
}

export interface OfflineAudioMarkMetadata {
  id: string; // composite key: `${bookHash}:${href}:${voiceId}`
  bookHash: string;
  href: string; // section identifier
  voiceId: string;
  contentHash: string; // hash of the text content for validation
  granularity: 'word' | 'sentence'; // must match during playback
  language: string; // primary language used
  marks: MarkTimingInfo[]; // array of mark timing metadata
  totalDuration: number; // total audio duration in ms
  createdAt: number;
}

export interface DownloadProgress {
  bookHash: string;
  totalSections: number;
  downloadedSections: number;
  failedSections: string[]; // hrefs that failed
  inProgress: boolean;
  startedAt?: number;
  completedAt?: number;
  lastError?: string;
}

export interface SectionCompletion {
  id: string; // composite key: `${bookHash}:${href}:${voiceId}`
  bookHash: string;
  href: string; // base href without chunk suffix
  voiceId: string;
  isComplete: boolean;
  totalChunks: number;
  completedAt?: number;
}

const DB_NAME = 'ReadestOfflineAudio';
const DB_VERSION = 2;
const AUDIO_STORE = 'audioRecords';
const PROGRESS_STORE = 'downloadProgress';
const COMPLETION_STORE = 'sectionCompletion';
const METADATA_STORE = 'markMetadata';

class OfflineAudioStorage {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB not supported'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Audio records store
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          const audioStore = db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
          audioStore.createIndex('bookHash', 'bookHash', { unique: false });
          audioStore.createIndex('href', 'href', { unique: false });
          audioStore.createIndex('bookHash_href', ['bookHash', 'href'], { unique: false });
        }

        // Download progress store
        if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
          db.createObjectStore(PROGRESS_STORE, { keyPath: 'bookHash' });
        }

        // Section completion store
        if (!db.objectStoreNames.contains(COMPLETION_STORE)) {
          const completionStore = db.createObjectStore(COMPLETION_STORE, { keyPath: 'id' });
          completionStore.createIndex('bookHash', 'bookHash', { unique: false });
          completionStore.createIndex('bookHash_voiceId', ['bookHash', 'voiceId'], { unique: false });
        }

        // Mark metadata store (for timing synchronization)
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          const metadataStore = db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
          metadataStore.createIndex('bookHash', 'bookHash', { unique: false });
          metadataStore.createIndex('bookHash_voiceId', ['bookHash', 'voiceId'], {
            unique: false,
          });
        }
      };
    });
  }

  private generateId(bookHash: string, href: string, voiceId: string): string {
    return `${bookHash}:${href}:${voiceId}`;
  }

  async saveAudio(record: Omit<OfflineAudioRecord, 'id'>): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(record.bookHash, record.href, record.voiceId);
    const fullRecord: OfflineAudioRecord = {
      ...record,
      id,
      downloadedAt: Date.now(),
      size: record.audioBlob.size,
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readwrite');
      const store = transaction.objectStore(AUDIO_STORE);
      const request = store.put(fullRecord);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAudio(bookHash: string, href: string, voiceId: string): Promise<OfflineAudioRecord | null> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readonly');
      const store = transaction.objectStore(AUDIO_STORE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async getBookAudio(bookHash: string): Promise<OfflineAudioRecord[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readonly');
      const store = transaction.objectStore(AUDIO_STORE);
      const index = store.index('bookHash');
      const request = index.getAll(bookHash);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async hasAudio(bookHash: string, href: string, voiceId: string): Promise<boolean> {
    const audio = await this.getAudio(bookHash, href, voiceId);
    return audio !== null;
  }

  async deleteAudio(bookHash: string, href: string, voiceId: string): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readwrite');
      const store = transaction.objectStore(AUDIO_STORE);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteBookAudio(bookHash: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readwrite');
      const store = transaction.objectStore(AUDIO_STORE);
      const index = store.index('bookHash');
      const request = index.openCursor(IDBKeyRange.only(bookHash));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  async getDownloadedHrefs(bookHash: string, voiceId: string): Promise<Set<string>> {
    const records = await this.getBookAudio(bookHash);
    const hrefs = records
      .filter((r) => r.voiceId === voiceId)
      .map((r) => r.href);
    return new Set(hrefs);
  }

  async saveProgress(progress: DownloadProgress): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([PROGRESS_STORE], 'readwrite');
      const store = transaction.objectStore(PROGRESS_STORE);
      const request = store.put(progress);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getProgress(bookHash: string): Promise<DownloadProgress | null> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([PROGRESS_STORE], 'readonly');
      const store = transaction.objectStore(PROGRESS_STORE);
      const request = store.get(bookHash);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteProgress(bookHash: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([PROGRESS_STORE], 'readwrite');
      const store = transaction.objectStore(PROGRESS_STORE);
      const request = store.delete(bookHash);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getTotalSize(bookHash?: string): Promise<number> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([AUDIO_STORE], 'readonly');
      const store = transaction.objectStore(AUDIO_STORE);

      let request: IDBRequest;
      if (bookHash) {
        const index = store.index('bookHash');
        request = index.getAll(bookHash);
      } else {
        request = store.getAll();
      }

      request.onsuccess = () => {
        const records = request.result as OfflineAudioRecord[];
        const totalSize = records.reduce((sum, record) => sum + (record.size || 0), 0);
        resolve(totalSize);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async markSectionComplete(
    bookHash: string,
    href: string,
    voiceId: string,
    totalChunks: number,
  ): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);
    const completion: SectionCompletion = {
      id,
      bookHash,
      href,
      voiceId,
      isComplete: true,
      totalChunks,
      completedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([COMPLETION_STORE], 'readwrite');
      const store = transaction.objectStore(COMPLETION_STORE);
      const request = store.put(completion);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async isSectionComplete(bookHash: string, href: string, voiceId: string): Promise<boolean> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([COMPLETION_STORE], 'readonly');
      const store = transaction.objectStore(COMPLETION_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        const completion = request.result as SectionCompletion | undefined;
        resolve(completion?.isComplete || false);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getCompletedSections(bookHash: string, voiceId: string): Promise<Set<string>> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([COMPLETION_STORE], 'readonly');
      const store = transaction.objectStore(COMPLETION_STORE);
      const index = store.index('bookHash_voiceId');
      const request = index.getAll([bookHash, voiceId]);

      request.onsuccess = () => {
        const completions = request.result as SectionCompletion[];
        const hrefs = new Set(
          completions.filter((c) => c.isComplete).map((c) => c.href),
        );
        resolve(hrefs);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteSectionCompletion(bookHash: string, href: string, voiceId: string): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([COMPLETION_STORE], 'readwrite');
      const store = transaction.objectStore(COMPLETION_STORE);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Mark Metadata Methods

  async saveMarkMetadata(metadata: Omit<OfflineAudioMarkMetadata, 'id'>): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(metadata.bookHash, metadata.href, metadata.voiceId);
    const record: OfflineAudioMarkMetadata = { ...metadata, id };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], 'readwrite');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getMarkMetadata(
    bookHash: string,
    href: string,
    voiceId: string,
  ): Promise<OfflineAudioMarkMetadata | null> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], 'readonly');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        resolve((request.result as OfflineAudioMarkMetadata) || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getBookMarkMetadata(bookHash: string): Promise<OfflineAudioMarkMetadata[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], 'readonly');
      const store = transaction.objectStore(METADATA_STORE);
      const index = store.index('bookHash');
      const request = index.getAll(bookHash);

      request.onsuccess = () => {
        resolve(request.result as OfflineAudioMarkMetadata[]);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteMarkMetadata(bookHash: string, href: string, voiceId: string): Promise<void> {
    if (!this.db) await this.init();

    const id = this.generateId(bookHash, href, voiceId);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], 'readwrite');
      const store = transaction.objectStore(METADATA_STORE);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteBookMarkMetadata(bookHash: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([METADATA_STORE], 'readwrite');
      const store = transaction.objectStore(METADATA_STORE);
      const index = store.index('bookHash');
      const request = index.openCursor(IDBKeyRange.only(bookHash));

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}

export const offlineAudioStorage = new OfflineAudioStorage();
