import React, { useEffect, useState } from 'react';
import { MdError, MdDownload } from 'react-icons/md';
import { offlineAudioManager } from '@/services/tts/OfflineAudioManager';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import clsx from 'clsx';
import { useTranslation } from '@/hooks/useTranslation';
import { useReaderStore } from '@/store/readerStore';

interface SidebarDownloadIndicatorProps {
  bookHash: string;
}

const SidebarDownloadIndicator: React.FC<SidebarDownloadIndicatorProps> = ({ bookHash }) => {
  const { setShowOfflineAudioDownload } = useReaderStore();
  const [isDownloading, setIsDownloading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const iconSize18 = useResponsiveSize(18);
  const _ = useTranslation();

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await offlineAudioManager.getStatus(bookHash, '');
        setIsDownloading(status.inProgress);

        // If it's not in progress, check if there was a recorded error in the last progress
        if (
          !status.inProgress &&
          status.progress?.lastError &&
          status.progress.lastError !== 'Download cancelled'
        ) {
          setHasError(true);
        } else {
          setHasError(false);
        }
      } catch (e) {
        console.error('Error checking download status', e);
      }
    };

    checkStatus();

    const onProgress = (event: Event) => {
      const { bookHash: eventBookHash } = (event as CustomEvent).detail;
      if (eventBookHash === bookHash) {
        setIsDownloading(true);
        setHasError(false);
      }
    };

    const onComplete = (event: Event) => {
      const { bookHash: eventBookHash } = (event as CustomEvent).detail;
      if (eventBookHash === bookHash) {
        setIsDownloading(false);
        setHasError(false);
        checkStatus(); // Re-check to be sure
      }
    };

    const onError = (event: Event) => {
      const { bookHash: eventBookHash, error } = (event as CustomEvent).detail;
      if (eventBookHash === bookHash) {
        setIsDownloading(false);
        if (error !== 'Download cancelled') {
          setHasError(true);
        } else {
          setHasError(false);
        }
      }
    };

    const onDeleted = (event: Event) => {
      const { bookHash: eventBookHash } = (event as CustomEvent).detail;
      if (eventBookHash === bookHash) {
        setIsDownloading(false);
        setHasError(false);
      }
    };

    const onErrorCleared = (event: Event) => {
      const { bookHash: eventBookHash } = (event as CustomEvent).detail;
      if (eventBookHash === bookHash) {
        setHasError(false);
      }
    };

    offlineAudioManager.addEventListener('download-progress', onProgress);
    offlineAudioManager.addEventListener('download-complete', onComplete);
    offlineAudioManager.addEventListener('download-error', onError);
    offlineAudioManager.addEventListener('download-deleted', onDeleted);
    offlineAudioManager.addEventListener('download-error-cleared', onErrorCleared);

    return () => {
      offlineAudioManager.removeEventListener('download-progress', onProgress);
      offlineAudioManager.removeEventListener('download-complete', onComplete);
      offlineAudioManager.removeEventListener('download-error', onError);
      offlineAudioManager.removeEventListener('download-deleted', onDeleted);
      offlineAudioManager.removeEventListener('download-error-cleared', onErrorCleared);
    };
  }, [bookHash]);

  if (!isDownloading && !hasError) {
    return null;
  }
  return (
    <>
      <style>
        {`
          @keyframes downloadArrow {
            0% { transform: translateY(-2px); opacity: 0.6; }
            50% { transform: translateY(2px); opacity: 1; }
            100% { transform: translateY(-2px); opacity: 0.6; }
          }
          .animate-download-custom {
            animation: downloadArrow 1.5s infinite ease-in-out;
          }
        `}
      </style>
      <button
        onClick={() => setShowOfflineAudioDownload(bookHash)}
        className={clsx(
          'btn btn-ghost hover:bg-base-300 h-6 min-h-6 w-6 rounded-full p-0 transition-colors',
          hasError ? 'text-error' : 'text-primary',
        )}
        title={hasError ? _('Download Error') : _('Downloading Audio...')}
      >
        {isDownloading ? (
          <MdDownload size={iconSize18} className='animate-download-custom' />
        ) : (
          <MdError size={iconSize18} />
        )}
      </button>
    </>
  );
};

export default SidebarDownloadIndicator;
