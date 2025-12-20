import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { MdDownload, MdClose, MdCheckCircle, MdError, MdDelete, MdCheck } from 'react-icons/md';
import { RiVoiceAiFill } from 'react-icons/ri';
import { useTranslation } from '@/hooks/useTranslation';
import { offlineAudioManager } from '@/services/tts/OfflineAudioManager';
import { DownloadProgress } from '@/services/tts/OfflineAudioStorage';
import { simpleHash } from '@/services/tts/utils';
import { TTSUtils } from '@/services/tts/TTSUtils';
import { useReaderStore } from '@/store/readerStore';
import { TTSVoicesGroup } from '@/services/tts';

interface OfflineAudioDownloadProps {
  bookKey: string;
  onClose?: () => void;
}

const OfflineAudioDownload: React.FC<OfflineAudioDownloadProps> = ({ bookKey, onClose }) => {
  const _ = useTranslation();
  const { getView, getViewSettings } = useReaderStore();

  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalSize, setTotalSize] = useState<number>(0);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  // Voice selection state
  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [downloadedVoiceId, setDownloadedVoiceId] = useState<string | null>(null);
  const [showVoiceConfirm, setShowVoiceConfirm] = useState(false);

  const view = getView(bookKey);
  const viewSettings = getViewSettings(bookKey);
  const bookDoc = view?.book || null;
  const getMetadataValue = (val: unknown) => {
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null) return (Object.values(val)[0] as string) || '';
    return '';
  };
  const identifier = bookDoc?.metadata?.identifier
    ? getMetadataValue(bookDoc.metadata.identifier)
    : '';
  const title = bookDoc?.metadata?.title ? getMetadataValue(bookDoc.metadata.title) : 'unknown';
  const bookId = bookDoc ? simpleHash(identifier || title) : '';

  const loadStatus = useCallback(async () => {
    try {
      await offlineAudioManager.init();
      const savedProgress = await offlineAudioManager.getStatus(bookId, '');
      setProgress(savedProgress.progress);

      const size = await offlineAudioManager.getTotalSize(bookId);
      setTotalSize(size);

      // Check for existing downloaded voice
      const dVoiceId = await offlineAudioManager.getDownloadedVoice(bookId);
      setDownloadedVoiceId(dVoiceId);
      if (dVoiceId) {
        setSelectedVoiceId(dVoiceId);
      }
    } catch (err) {
      console.error('Error loading offline audio status:', err);
    }
  }, [bookId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const loadVoices = async () => {
      if (!bookDoc) return;
      const langVal = bookDoc.metadata?.language;
      const primaryLang = typeof langVal === 'string' ? langVal : 'en';
      const groups = await offlineAudioManager.getVoices(primaryLang);
      setVoiceGroups(groups);

      // Default selection if not already set (and no existing download)
      if (!selectedVoiceId && !downloadedVoiceId) {
        let defaultVoice = '';

        // 1. Check for book-specific preference
        const bookPrefVoice = TTSUtils.getBookPreferredVoice(bookId);
        if (bookPrefVoice) {
          defaultVoice = bookPrefVoice;
        }

        // 2. Check for active online voice (viewSettings)
        if (!defaultVoice && viewSettings?.ttsVoice) {
          defaultVoice = viewSettings.ttsVoice;
        }

        // 3. Check for global preference
        if (!defaultVoice) {
          const preferredClient = TTSUtils.getPreferredClient();
          if (preferredClient) {
            const globalVoice = TTSUtils.getPreferredVoice(preferredClient, primaryLang);
            if (globalVoice) {
              defaultVoice = globalVoice;
            }
          }
        }

        // 4. Smart Default (Kokoro or Edge)
        if (!defaultVoice) {
          defaultVoice =
            groups.find((g) => g.id === 'http-tts')?.voices[0]?.id ||
            groups[0]?.voices[0]?.id ||
            'en-US-AriaNeural';
        }

        if (defaultVoice) {
          setSelectedVoiceId(defaultVoice);
        }
      }
    };
    loadVoices();
  }, [bookDoc, downloadedVoiceId, selectedVoiceId, bookId, viewSettings?.ttsVoice]);

  const startDownload = useCallback(async () => {
    if (!bookDoc) return;

    setIsDownloading(true);
    setError(null);
    setShowVoiceConfirm(false);

    // If changing voice, delete old one first
    if (downloadedVoiceId && downloadedVoiceId !== selectedVoiceId) {
      try {
        await offlineAudioManager.deleteBook(bookId);
        setDownloadedVoiceId(null);
      } catch (e) {
        console.error('Error deleting old audio:', e);
        // proceed anyway?
      }
    }

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await offlineAudioManager.init();

      // Get TTS settings (you might need to adjust these based on your actual settings)
      const voiceId = selectedVoiceId || 'en-US-AriaNeural'; // Default voice
      const rate = 1.0;
      const pitch = 1.0;
      const langVal = bookDoc.metadata?.language;
      const primaryLang = typeof langVal === 'string' ? langVal : 'en';

      await offlineAudioManager.downloadBook({
        bookHash: bookId,
        bookDoc,
        voiceId,
        rate,
        pitch,
        primaryLang,
        onProgress: (p) => {
          setProgress(p);
        },
        signal: controller.signal,
      });

      // Update total size after download
      const size = await offlineAudioManager.getTotalSize(bookId);
      setTotalSize(size);
      setDownloadedVoiceId(voiceId);
    } catch (err) {
      if (err instanceof Error && err.message !== 'Download cancelled') {
        setError(err.message);
      }
    } finally {
      setIsDownloading(false);
      setAbortController(null);
    }
  }, [bookDoc, bookId, selectedVoiceId, downloadedVoiceId]);

  const handleDownload = useCallback(async () => {
    if (!bookDoc) {
      setError('Book not loaded');
      return;
    }

    // Check for voice mismatch
    if (downloadedVoiceId && selectedVoiceId && downloadedVoiceId !== selectedVoiceId) {
      setShowVoiceConfirm(true);
      return;
    }

    startDownload();
  }, [bookDoc, downloadedVoiceId, selectedVoiceId, startDownload]);

  const handleCancel = useCallback(() => {
    if (abortController) {
      abortController.abort();
    }
  }, [abortController]);

  const handleDelete = useCallback(async () => {
    try {
      await offlineAudioManager.deleteBook(bookId);
      setProgress(null);
      setTotalSize(0);
      setDownloadedVoiceId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [bookId]);

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const getProgressPercentage = (): number => {
    if (!progress || progress.totalSections === 0) return 0;
    return Math.round((progress.downloadedSections / progress.totalSections) * 100);
  };

  const hasDownloads = progress !== null;
  const isComplete = progress
    ? progress.downloadedSections === progress.totalSections && !progress.inProgress
    : false;
  const isPartiallyDownloaded = hasDownloads && !isComplete;

  return (
    <div className='bg-base-100 border-base-200 max-w-md rounded-lg border p-4 shadow-lg'>
      <div className='mb-4 flex items-center justify-between'>
        <h3 className='flex items-center gap-2 text-lg font-semibold'>
          <MdDownload className='text-xl' />
          {_('Offline Audio')}
        </h3>
        {onClose && (
          <button onClick={onClose} className='btn btn-sm btn-ghost btn-circle'>
            <MdClose className='text-xl' />
          </button>
        )}
      </div>

      {/* Voice Selection */}
      <div className='dropdown dropdown-bottom mb-4 w-full'>
        <div
          role='button'
          tabIndex={0}
          className={clsx(
            'btn btn-outline w-full justify-between',
            (isDownloading || isPartiallyDownloaded) && 'btn-disabled',
          )}
        >
          <div className='flex items-center gap-2'>
            <RiVoiceAiFill className='text-xl' />
            <span className='truncate'>
              {voiceGroups.flatMap((g) => g.voices).find((v) => v.id === selectedVoiceId)?.name ||
                _('Select Voice')}
            </span>
          </div>
          <MdDownload className='rotate-90 text-xs' />
        </div>
        <ul className='dropdown-content menu bg-base-100 rounded-box z-[1] block max-h-60 w-full flex-nowrap overflow-y-auto p-2 shadow'>
          {voiceGroups.map(
            (group) =>
              (
                <li
                  key={group.id}
                  className='menu-title px-2 py-1 text-xs font-bold uppercase tracking-wider opacity-50'
                >
                  {group.name}
                </li>
              ) || [] /* safeguard */,
          )}
          {voiceGroups.map((group) => (
            <React.Fragment key={group.id}>
              <li className='menu-title border-base-200 mt-2 border-b px-2 py-1 text-xs font-bold uppercase tracking-wider opacity-50 first:mt-0'>
                {group.name}
              </li>
              {group.voices.map((voice) => (
                <li key={voice.id}>
                  <button
                    type='button'
                    className={clsx(
                      'flex w-full items-center justify-between text-left',
                      selectedVoiceId === voice.id && 'active',
                    )}
                    onClick={() => {
                      if (document.activeElement instanceof HTMLElement)
                        document.activeElement.blur();
                      setSelectedVoiceId(voice.id);
                      TTSUtils.setBookPreferredVoice(bookId, voice.id);
                    }}
                  >
                    <span>{voice.name}</span>
                    {selectedVoiceId === voice.id && <MdCheck />}
                  </button>
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
      </div>

      {/* Delete Confirmation Modal/Overlay (Inline) */}
      {showVoiceConfirm && (
        <div className='alert alert-warning mb-4'>
          <div>
            <h3 className='font-bold'>{_('Change Voice?')}</h3>
            <div className='text-xs'>
              {_('This will delete existing offline audio for this book.')}
            </div>
          </div>
          <div className='flex flex-col gap-2'>
            <button onClick={startDownload} className='btn btn-sm btn-error'>
              {_('Delete & Download')}
            </button>
            <button onClick={() => setShowVoiceConfirm(false)} className='btn btn-sm btn-ghost'>
              {_('Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Status */}
      <div className='space-y-3'>
        {/* Download button */}
        {!isComplete && !isDownloading && (
          <button
            onClick={handleDownload}
            className='btn btn-primary btn-block'
            disabled={!bookDoc}
          >
            <MdDownload className='text-xl' />
            {hasDownloads ? _('Resume Download') : _('Download for Offline Listening')}
          </button>
        )}

        {/* Progress */}
        {isDownloading && progress && (
          <div className='space-y-2'>
            <div className='flex items-center justify-between text-sm'>
              <span>
                {_('Downloading')}... {progress.downloadedSections} / {progress.totalSections}
              </span>
              <span>{getProgressPercentage()}%</span>
            </div>
            <progress
              className='progress progress-primary w-full'
              value={getProgressPercentage()}
              max={100}
            />
            <button onClick={handleCancel} className='btn btn-sm btn-error btn-block'>
              <MdClose />
              {_('Cancel')}
            </button>
          </div>
        )}

        {/* Complete */}
        {isComplete && (
          <div className='alert alert-success'>
            <MdCheckCircle className='text-xl' />
            <span>
              {_('Download Complete')} - {progress?.downloadedSections} {_('sections')}
            </span>
          </div>
        )}

        {/* Partial download */}
        {hasDownloads && !isComplete && !isDownloading && (
          <div className='alert alert-info'>
            <MdCheckCircle className='text-xl' />
            <span>
              {progress!.downloadedSections} / {progress!.totalSections} {_('sections downloaded')}
            </span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className='alert alert-error'>
            <MdError className='text-xl' />
            <span>{error}</span>
          </div>
        )}

        {/* Failed sections */}
        {progress && progress.failedSections.length > 0 && (
          <div className='alert alert-warning'>
            <MdError className='text-xl' />
            <span>
              {progress.failedSections.length} {_('sections failed to download')}
            </span>
          </div>
        )}

        {/* Storage info */}
        {totalSize > 0 && (
          <div className='text-base-content/70 text-sm'>
            {_('Storage used')}: {formatSize(totalSize)}
          </div>
        )}

        {/* Delete button */}
        {hasDownloads && (
          <button
            onClick={handleDelete}
            className='btn btn-sm btn-error btn-block'
            disabled={isDownloading}
          >
            <MdDelete />
            {_('Delete Downloaded Audio')}
          </button>
        )}
      </div>

      {/* Info */}
      <div className='text-base-content/60 mt-4 text-xs'>
        {_('Download audio for all chapters to listen offline.')}
      </div>
    </div>
  );
};

export default OfflineAudioDownload;
