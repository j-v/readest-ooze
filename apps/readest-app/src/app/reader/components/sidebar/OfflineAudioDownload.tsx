import React, { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { MdDownload, MdClose, MdCheckCircle, MdError, MdDelete } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { offlineAudioManager } from '@/services/tts/OfflineAudioManager';
import { DownloadProgress } from '@/services/tts/OfflineAudioStorage';
import { useReaderStore } from '@/store/readerStore';

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

  const view = getView(bookKey);
  const bookDoc = view?.book || null;
  const viewSettings = getViewSettings(bookKey);

  // Extract stable book identifier (metaHash) instead of dynamic bookKey
  const bookId = bookKey.split('-')[0]!;

  const loadStatus = useCallback(async () => {
    try {
      await offlineAudioManager.init();
      const savedProgress = await offlineAudioManager.getStatus(bookId, '');
      setProgress(savedProgress.progress);
      const size = await offlineAudioManager.getTotalSize(bookId);
      setTotalSize(size);
    } catch (err) {
      console.error('Error loading offline audio status:', err);
    }
  }, [bookId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleDownload = useCallback(async () => {
    if (!bookDoc) {
      setError('Book not loaded');
      return;
    }

    setIsDownloading(true);
    setError(null);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      await offlineAudioManager.init();

      // Get TTS settings (you might need to adjust these based on your actual settings)
      const voiceId = 'en-US-AriaNeural'; // Default voice
      const rate = 1.0;
      const pitch = 1.0;
      const primaryLang = (bookDoc.metadata?.language as string) || 'en';

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
    } catch (err) {
      if (err instanceof Error && err.message !== 'Download cancelled') {
        setError(err.message);
      }
    } finally {
      setIsDownloading(false);
      setAbortController(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookDoc, bookId]);

  const handleCancel = useCallback(() => {
    if (abortController) {
      abortController.abort();
      offlineAudioManager.cancelDownload(bookId);
    }
  }, [abortController, bookId]);

  const handleDelete = useCallback(async () => {
    try {
      await offlineAudioManager.deleteBook(bookId);
      setProgress(null);
      setTotalSize(0);
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

  const hasDownloads = progress && progress.downloadedSections > 0;
  const isComplete = progress && progress.downloadedSections === progress.totalSections && !progress.inProgress;

  return (
    <div className='bg-base-100 rounded-lg shadow-lg border border-base-200 p-4 max-w-md'>
      <div className='flex items-center justify-between mb-4'>
        <h3 className='text-lg font-semibold flex items-center gap-2'>
          <MdDownload className='text-xl' />
          {_('Offline Audio')}
        </h3>
        {onClose && (
          <button onClick={onClose} className='btn btn-sm btn-ghost btn-circle'>
            <MdClose className='text-xl' />
          </button>
        )}
      </div>

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
              {_('Download Complete')} - {progress.downloadedSections} {_('sections')}
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
          <div className='text-sm text-base-content/70'>
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
      <div className='mt-4 text-xs text-base-content/60'>
        {_('Download audio for all chapters to listen offline. Uses Edge TTS voice.')}
      </div>
    </div>
  );
};

export default OfflineAudioDownload;
