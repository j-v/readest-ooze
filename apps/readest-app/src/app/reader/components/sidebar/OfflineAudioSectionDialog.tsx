import React, { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { MdDownload, MdClose, MdCheckCircle, MdError, MdDelete, MdCheck } from 'react-icons/md';
import { RiVoiceAiFill } from 'react-icons/ri';
import { useTranslation } from '@/hooks/useTranslation';
import { offlineAudioManager } from '@/services/tts/OfflineAudioManager';
import { useReaderStore } from '@/store/readerStore';
import { TTSVoicesGroup } from '@/services/tts';
import { TTSUtils } from '@/services/tts/TTSUtils';
import { TOCItem } from '@/libs/document';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookLanguage } from '@/hooks/useBookLanguage';

interface OfflineAudioSectionDialogProps {
  bookKey: string;
  tocItem: TOCItem;
  isOpen: boolean;
  onClose: () => void;
}

const OfflineAudioSectionDialog: React.FC<OfflineAudioSectionDialogProps> = ({
  bookKey,
  tocItem,
  isOpen,
  onClose,
}) => {
  const _ = useTranslation();
  const { getView, getProgress, getViewSettings } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const ttsLang = useBookLanguage(bookKey);

  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ downloaded: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [downloadedVoiceId, setDownloadedVoiceId] = useState<string | null>(null);

  const view = getView(bookKey);
  const viewSettings = getViewSettings(bookKey);
  const bookDoc = view?.book || null;

  // Extract stable book identifier (metaHash) instead of computing a new hash
  // This must match how TOCView computes bookId so checkmarks appear correctly
  const bookId = bookKey.split('-')[0]!;
  const href = tocItem.href || '';

  // Load section status
  const loadStatus = useCallback(async () => {
    if (!href) return;
    try {
      await offlineAudioManager.init();
      const voiceId = await offlineAudioManager.getDownloadedVoiceForSection(bookId, href);
      setDownloadedVoiceId(voiceId);
      if (voiceId) {
        setSelectedVoiceId(voiceId);
      }
    } catch (err) {
      console.error('Error loading section status:', err);
    }
  }, [bookId, href]);

  useEffect(() => {
    if (isOpen) {
      loadStatus();
    }
  }, [isOpen, loadStatus]);

  // Load voices
  useEffect(() => {
    const loadVoices = async () => {
      if (!bookDoc || !view) return;

      const groups = await offlineAudioManager.getVoices(ttsLang);
      setVoiceGroups(groups);

      // Set default voice if not already set
      if (!selectedVoiceId && !downloadedVoiceId) {
        let defaultVoice = '';

        // 1. Check last downloaded voice in book
        const bookVoice = await offlineAudioManager.getDownloadedVoice(bookId);
        if (bookVoice) defaultVoice = bookVoice;

        // 2. Active online voice
        if (!defaultVoice && viewSettings?.ttsVoice) {
          defaultVoice = viewSettings.ttsVoice;
        }

        // 3. Global preference
        if (!defaultVoice) {
          // TODO preferred client might not support offline?
          const preferredClient = TTSUtils.getPreferredClient();
          if (preferredClient) {
            const globalVoice = TTSUtils.getPreferredVoice(preferredClient, ttsLang);
            if (globalVoice) defaultVoice = globalVoice;
          }
        }

        // 4. Fallback
        if (!defaultVoice) {
          defaultVoice =
            groups.find((g) => g.id === 'http-tts')?.voices[0]?.id ||
            groups[0]?.voices[0]?.id ||
            'en-US-AriaNeural';
        }

        setSelectedVoiceId(defaultVoice);
      }
    };
    if (isOpen) loadVoices();
  }, [
    bookDoc,
    view,
    getProgress,
    bookKey,
    getBookData,
    isOpen,
    bookId,
    downloadedVoiceId,
    selectedVoiceId,
    viewSettings?.ttsVoice,
  ]);

  const handleDownload = useCallback(async () => {
    if (!bookDoc || !href) return;

    setIsDownloading(true);
    setError(null);
    setDownloadProgress({ downloaded: 0, total: 0 });

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await offlineAudioManager.init();

      const voiceId = selectedVoiceId || 'en-US-AriaNeural';
      const langVal = bookDoc.metadata?.language;
      const primaryLang = typeof langVal === 'string' ? langVal : 'en';
      console.log('[OfflineAudioSectionDialog] Starting download:', {
        bookId,
        href: tocItem.href,
        voiceId,
      });

      await offlineAudioManager.downloadSingleSection({
        bookHash: bookId,
        bookDoc,
        tocItem,
        voiceId,
        rate: 1.0,
        pitch: 1.0,
        primaryLang,
        onProgress: (downloaded, total) => {
          setDownloadProgress({ downloaded, total });
        },
        signal: controller.signal,
      });

      setDownloadedVoiceId(voiceId);
    } catch (err) {
      if (err instanceof Error && err.message !== 'Download cancelled') {
        setError(err.message);
      }
    } finally {
      setIsDownloading(false);
      setAbortController(null);
    }
  }, [bookDoc, bookId, href, selectedVoiceId, tocItem]);

  const handleCancel = useCallback(() => {
    if (abortController) {
      abortController.abort();
    }
  }, [abortController]);

  const handleDelete = useCallback(async () => {
    if (!href || !downloadedVoiceId) return;
    try {
      await offlineAudioManager.deleteSingleSection(bookId, href, downloadedVoiceId);
      setDownloadedVoiceId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [bookId, downloadedVoiceId, href]);

  const voiceDropdownRef = useRef<HTMLDetailsElement>(null);

  if (!isOpen) return null;

  const isDownloaded = !!downloadedVoiceId;
  const progressPercent =
    downloadProgress.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : 0;

  return (
    <div className='modal modal-open'>
      <div className='modal-box max-w-md overflow-visible'>
        {/* Header */}
        <div className='mb-4 flex items-center justify-between'>
          <h3 className='flex items-center gap-2 text-lg font-semibold'>
            <MdDownload className='text-xl' />
            {_('Offline Audio')}
          </h3>
          <button onClick={onClose} className='btn btn-sm btn-ghost btn-circle'>
            <MdClose className='text-xl' />
          </button>
        </div>

        {/* Chapter Title */}
        <div className='mb-4'>
          <span className='text-sm opacity-70'>{_('Chapter')}</span>
          <p className='font-medium'>{tocItem.label || href}</p>
        </div>

        {/* Voice Selection */}
        <details ref={voiceDropdownRef} className='dropdown dropdown-bottom mb-4 w-full'>
          <summary
            className={clsx(
              'btn btn-outline w-full justify-between',
              (isDownloading || isDownloaded) && 'btn-disabled',
            )}
          >
            <div className='flex items-center gap-2'>
              <RiVoiceAiFill className='text-xl' />
              <span className='truncate'>
                {voiceGroups.flatMap((g) => g.voices).find((v) => v.id === selectedVoiceId)?.name ||
                  _('Select Voice')}
              </span>
            </div>
          </summary>
          {!isDownloaded && !isDownloading && (
            <ul className='dropdown-content menu bg-base-100 rounded-box z-[1] block max-h-60 w-full overflow-y-auto p-2 shadow'>
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
                          // Close the dropdown
                          if (voiceDropdownRef.current) {
                            voiceDropdownRef.current.removeAttribute('open');
                          }
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
          )}
        </details>

        {/* Status */}
        <div className='space-y-3'>
          {/* Download button */}
          {!isDownloaded && !isDownloading && (
            <button onClick={handleDownload} className='btn btn-primary btn-block' disabled={!href}>
              <MdDownload className='text-xl' />
              {_('Download')}
            </button>
          )}

          {/* Progress */}
          {isDownloading && (
            <div className='space-y-2'>
              <div className='flex items-center justify-between text-sm'>
                <span>
                  {_('Downloading')}... {downloadProgress.downloaded} / {downloadProgress.total}
                </span>
                <span>{progressPercent}%</span>
              </div>
              <progress
                className='progress progress-primary w-full'
                value={progressPercent}
                max={100}
              />
              <button onClick={handleCancel} className='btn btn-sm btn-error btn-block'>
                <MdClose />
                {_('Cancel')}
              </button>
            </div>
          )}

          {/* Complete */}
          {isDownloaded && !isDownloading && (
            <div className='alert alert-success'>
              <MdCheckCircle className='text-xl' />
              <span>{_('Downloaded')}</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className='alert alert-error'>
              <MdError className='text-xl' />
              <span>{error}</span>
            </div>
          )}

          {/* Delete button */}
          {isDownloaded && !isDownloading && (
            <button onClick={handleDelete} className='btn btn-sm btn-error btn-block'>
              <MdDelete />
              {_('Delete Downloaded Audio')}
            </button>
          )}
        </div>
      </div>
      <div className='modal-backdrop' onClick={onClose}></div>
    </div>
  );
};

export default OfflineAudioSectionDialog;
