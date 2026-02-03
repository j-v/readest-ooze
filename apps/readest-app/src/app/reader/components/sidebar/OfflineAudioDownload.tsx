import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { MdDownload, MdClose, MdDelete, MdCheck } from 'react-icons/md';
import { RiVoiceAiFill } from 'react-icons/ri';
import { useTranslation } from '@/hooks/useTranslation';
import { offlineAudioManager, DownloadProgress } from '@/services/tts/OfflineAudioManager';
import { TTSUtils } from '@/services/tts/TTSUtils';
import { useReaderStore } from '@/store/readerStore';
import { TTSVoicesGroup } from '@/services/tts';
import { getLocale } from '@/utils/misc';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBookLanguage } from '@/hooks/useBookLanguage';
import { TOCItem } from '@/libs/document';

interface OfflineAudioDownloadProps {
  bookKey: string;
  onClose?: () => void;
}

const OfflineAudioDownload: React.FC<OfflineAudioDownloadProps> = ({ bookKey, onClose }) => {
  const _ = useTranslation();
  const { getViewSettings, getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();

  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalSize, setTotalSize] = useState<number>(0);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  // Selection State
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [downloadedHrefs, setDownloadedHrefs] = useState<Set<string>>(new Set());
  const [downloadingHref, setDownloadingHref] = useState<string | null>(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  // Voice selection state
  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [downloadedVoiceId, setDownloadedVoiceId] = useState<string | null>(null);
  const [showVoiceConfirm, setShowVoiceConfirm] = useState(false);

  const bookData = getBookData(bookKey);
  const viewSettings = getViewSettings(bookKey);
  const bookDoc = bookData?.bookDoc || null;
  const bookId = bookKey.split('-')[0]!;
  const ttsLang = useBookLanguage(bookKey);
  const currentSectionHref = getProgress(bookKey)?.sectionHref;

  const currentChapterRef = useRef<HTMLLIElement>(null);

  // Flatten TOC for checklist
  const flatTOC = useMemo(() => {
    if (!bookDoc?.toc) return [];
    const flatten = (items: TOCItem[], depth = 0): { item: TOCItem; depth: number }[] => {
      const result: { item: TOCItem; depth: number }[] = [];
      for (const item of items) {
        if (item.href) {
          result.push({ item, depth });
        }
        if (item.subitems) {
          result.push(...flatten(item.subitems, depth + 1));
        }
      }
      return result;
    };
    return flatten(bookDoc.toc);
  }, [bookDoc]);

  // Load Status
  const loadStatus = useCallback(async () => {
    try {
      await offlineAudioManager.init();

      const status = await offlineAudioManager.getStatus(bookId, '');
      setIsDownloading(status.inProgress);
      if (status.inProgress && status.progress) {
        setDownloadProgress(status.progress);
      } else if (
        !status.inProgress &&
        status.progress?.lastError &&
        status.progress.lastError !== 'Download cancelled'
      ) {
        // setError(status.progress.lastError);
        setError('Failed to download audio, check your network connection');
      }

      const dHrefs = await offlineAudioManager.getAllDownloadedSections(bookId);
      setDownloadedHrefs(dHrefs);

      const size = await offlineAudioManager.getTotalSize(bookId);
      setTotalSize(size);

      const dVoiceId = await offlineAudioManager.getDownloadedVoice(bookId);
      setDownloadedVoiceId(dVoiceId);
      if (dVoiceId) {
        setSelectedVoiceId(dVoiceId);
      }
    } catch (err) {
      console.error('Error loading offline audio status:', err);
    }
  }, [bookId]);

  // Event Listeners
  useEffect(() => {
    const onDownloadProgress = (event: Event) => {
      const { bookHash, current, total, href } = (event as CustomEvent).detail;
      if (bookHash === bookId) {
        setIsDownloading(true);
        setDownloadingHref(href);
        setDownloadProgress((prev) => ({
          bookHash,
          totalSections: total,
          downloadedSections: current,
          failedSections: prev?.failedSections || [],
          inProgress: true,
          startedAt: prev?.startedAt || Date.now(),
        }));
      }
    };

    const onDownloadComplete = (event: Event) => {
      const { bookHash } = (event as CustomEvent).detail;
      if (bookHash === bookId) {
        setIsDownloading(false);
        setDownloadingHref(null);
        setDownloadProgress(null);
        loadStatus();
      }
    };

    // Also listen for single section completions to update checkmarks immediately
    const onSectionComplete = (event: Event) => {
      const { bookHash, href } = (event as CustomEvent).detail;
      if (bookHash === bookId) {
        setDownloadedHrefs((prev) => {
          const next = new Set(prev);
          next.add(href);
          return next;
        });
        setDownloadingHref(null);
        // If we are tracking batch progress, we might want to reload total size occasionally
      }
    };

    const onDownloadError = (event: Event) => {
      const { bookHash } = (event as CustomEvent).detail;
      if (bookHash === bookId) {
        setIsDownloading(false);
        setDownloadingHref(null);
        setDownloadProgress(null);
        loadStatus();
      }
    };

    const onDeleted = (event: Event) => {
      const { bookHash } = (event as CustomEvent).detail;
      if (bookHash === bookId) loadStatus();
    };

    // TODO duplicate handlers?
    offlineAudioManager.addEventListener('download-progress', onDownloadProgress);
    offlineAudioManager.addEventListener('download-complete', onDownloadComplete);
    offlineAudioManager.addEventListener('download-error', onDownloadError);
    offlineAudioManager.addEventListener('section-download-complete', onSectionComplete);
    offlineAudioManager.addEventListener('download-deleted', onDeleted);
    offlineAudioManager.addEventListener('section-download-deleted', onDeleted); // Handle section deletes

    return () => {
      offlineAudioManager.removeEventListener('download-progress', onDownloadProgress);
      offlineAudioManager.removeEventListener('download-complete', onDownloadComplete);
      offlineAudioManager.removeEventListener('download-error', onDownloadError);
      offlineAudioManager.removeEventListener('section-download-complete', onSectionComplete);
      offlineAudioManager.removeEventListener('download-deleted', onDeleted);
      offlineAudioManager.removeEventListener('section-download-deleted', onDeleted);
    };
  }, [bookId, loadStatus]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Scroll to current chapter
  useEffect(() => {
    if (currentChapterRef.current) {
      currentChapterRef.current.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }, [currentSectionHref, flatTOC.length]); // Scroll when current section changes or TOC is loaded

  // Voice Loading
  useEffect(() => {
    const loadVoices = async () => {
      if (!bookDoc) return;
      const groups = await offlineAudioManager.getVoices(ttsLang);
      setVoiceGroups(groups);

      if (!selectedVoiceId && !downloadedVoiceId) {
        let defaultVoice = '';
        if (viewSettings?.ttsVoice) defaultVoice = viewSettings.ttsVoice;
        if (!defaultVoice) {
          const preferredClient = TTSUtils.getPreferredClient();
          if (preferredClient) {
            const globalVoice = TTSUtils.getPreferredVoice(preferredClient, ttsLang);
            if (globalVoice) defaultVoice = globalVoice;
          }
        }
        if (!defaultVoice) {
          defaultVoice =
            groups.find((g) => g.id === 'http-tts')?.voices[0]?.id ||
            groups[0]?.voices[0]?.id ||
            'en-US-AriaNeural';
        }
        if (defaultVoice) setSelectedVoiceId(defaultVoice);
      }
    };
    loadVoices();
  }, [bookDoc, bookKey, downloadedVoiceId, selectedVoiceId, viewSettings?.ttsVoice, ttsLang]);

  // Actions
  const handleToggleSelection = (href: string, index: number, isShift?: boolean) => {
    if (isDownloading) return;
    setSelection((prev) => {
      const next = new Set(prev);
      if (isShift && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        const rangeHrefs = flatTOC.slice(start, end + 1).map((x) => x.item.href || '');

        const shouldSelect = !prev.has(href);
        rangeHrefs.forEach((h) => {
          if (shouldSelect) next.add(h);
          else next.delete(h);
        });
      } else {
        if (next.has(href)) next.delete(href);
        else next.add(href);
      }
      return next;
    });
    setLastSelectedIndex(index);
  };

  const handleSelectAll = () => {
    if (isDownloading) return;
    setSelection(new Set(flatTOC.map((x) => x.item.href || '')));
  };

  const handleSelectNone = () => {
    if (isDownloading) return;
    setSelection(new Set());
  };

  const handleSelectMissing = () => {
    if (isDownloading) return;
    const missing = flatTOC
      .filter((x) => !downloadedHrefs.has(x.item.href || ''))
      .map((x) => x.item.href || '');
    setSelection(new Set(missing));
  };

  const handleSelectUnread = () => {
    if (isDownloading) return;
    const currentIndex = flatTOC.findIndex((x) => x.item.href === currentSectionHref);
    if (currentIndex === -1) return;

    const unread = flatTOC
      .slice(currentIndex)
      .filter((x) => !downloadedHrefs.has(x.item.href || ''))
      .map((x) => x.item.href || '');
    setSelection(new Set(unread));
  };

  const getTTSTargetLang = useCallback((): string | undefined => {
    const ttsReadAloudText = viewSettings?.ttsReadAloudText;
    if (viewSettings?.translationEnabled && ttsReadAloudText === 'translated') {
      return viewSettings?.translateTargetLang || getLocale();
    } else if (viewSettings?.translationEnabled && ttsReadAloudText === 'source') {
      const bookData = getBookData(bookKey);
      return bookData?.book?.primaryLanguage || '';
    }
    return undefined;
  }, [
    bookKey,
    getBookData,
    viewSettings?.translationEnabled,
    viewSettings?.ttsReadAloudText,
    viewSettings?.translateTargetLang,
  ]);

  const handleDownloadSelected = async () => {
    if (!bookDoc || isDownloading) return;

    // Check voice
    if (downloadedVoiceId && selectedVoiceId && downloadedVoiceId !== selectedVoiceId) {
      setShowVoiceConfirm(true);
      return;
    }

    startDownloadBatch();
  };

  const startDownloadBatch = async () => {
    setError(null);
    setIsDownloading(true);
    setShowVoiceConfirm(false);

    // Filter selection to TOC Items
    const selectedItems = flatTOC
      .filter((x) => selection.has(x.item.href || '') && !downloadedHrefs.has(x.item.href || ''))
      .map((x) => x.item);

    setDownloadProgress({
      bookHash: bookId,
      totalSections: selectedItems.length,
      downloadedSections: 0,
      failedSections: [],
      inProgress: true,
      startedAt: Date.now(),
    });

    const voiceId = selectedVoiceId || 'en-US-AriaNeural';
    const langVal = bookDoc?.metadata?.language;
    const primaryLang = typeof langVal === 'string' ? langVal : 'en';
    const targetLang = getTTSTargetLang();

    // Note: If voice changed, we might need to delete old stuff first.
    // Existing logic in old component did this.
    // if (downloadedVoiceId && downloadedVoiceId !== selectedVoiceId) {
    //   try {
    //     await offlineAudioManager.deleteBook(bookId);
    //     setDownloadedVoiceId(null);
    //     setDownloadedHrefs(new Set());
    //   } catch (e) {
    //     console.error(e);
    //   }
    // }

    try {
      await offlineAudioManager.init();
      await offlineAudioManager.downloadSections({
        bookHash: bookId,
        bookDoc: bookDoc!,
        sections: selectedItems,
        voiceId,
        rate: 1.0,
        pitch: 1.0,
        primaryLang,
        targetLang,
      });
      setDownloadedVoiceId(voiceId);
    } catch (err) {
      if (err instanceof Error && err.message !== 'Download cancelled') {
        setError(err.message);
      }
    } finally {
      setIsDownloading(false);
      loadStatus();
    }
  };

  const handleDeleteSelected = async () => {
    if (isDownloading) return;
    const toDelete = Array.from(selection).filter((href) => downloadedHrefs.has(href));
    if (toDelete.length === 0) return;

    setIsDownloading(true); // Lock UI
    try {
      await offlineAudioManager.deleteSections(bookId, toDelete);
      // Manually update local state for speed, though event listener will also fire
      setDownloadedHrefs((prev) => {
        const next = new Set(prev);
        toDelete.forEach((h) => next.delete(h));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsDownloading(false);
      loadStatus();
    }
  };

  const handleCancel = () => {
    offlineAudioManager.cancelDownload(bookId);
    setIsDownloading(false); // optimistic update
    setDownloadingHref(null);
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const voiceDropdownRef = useRef<HTMLDetailsElement>(null);

  // Computed states for buttons
  const isSelectionEmpty = selection.size === 0;
  const hasMissingInSelection = Array.from(selection).some((h) => !downloadedHrefs.has(h));
  const hasDownloadedInSelection = Array.from(selection).some((h) => downloadedHrefs.has(h));

  const downloadCount = Array.from(selection).filter((h) => !downloadedHrefs.has(h)).length;
  const deleteCount = Array.from(selection).filter((h) => downloadedHrefs.has(h)).length;

  return (
    <div className='bg-base-100 border-base-200 flex h-[80vh] max-h-[600px] w-full max-w-md flex-col rounded-lg border shadow-lg'>
      {/* HEADER */}
      <div className='border-base-200 flex-shrink-0 border-b p-4 pb-2'>
        <div className='mb-2 flex items-center justify-between'>
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

        {/* Stats & Tools */}
        <div className='mb-2 flex items-center justify-between text-xs opacity-70'>
          <span>
            {downloadedHrefs.size} / {flatTOC.length} {_('Downloaded')} ({formatSize(totalSize)})
          </span>
        </div>

        {/* Voice Selection */}
        <details ref={voiceDropdownRef} className='dropdown dropdown-bottom w-full'>
          <summary
            className={clsx(
              'btn btn-sm btn-outline w-full justify-between',
              isDownloading && 'btn-disabled',
            )}
          >
            <div className='flex items-center gap-2'>
              <RiVoiceAiFill />
              <span className='truncate'>
                {voiceGroups.flatMap((g) => g.voices).find((v) => v.id === selectedVoiceId)?.name ||
                  _('Select Voice')}
              </span>
            </div>
            <MdDownload className='rotate-90 text-xs' />
          </summary>
          {/* ... Dropdown content (same as before) ... */}
          <ul className='dropdown-content menu bg-base-100 rounded-box z-[1] block max-h-60 w-full flex-nowrap overflow-y-auto p-2 shadow'>
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
                        setSelectedVoiceId(voice.id);
                        voiceDropdownRef.current?.removeAttribute('open');
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
        </details>
      </div>
      {/* TOOLBAR */}
      <div className='bg-base-200/50 border-base-200 flex flex-shrink-0 gap-2 border-b px-4 py-2 text-xs'>
        <button onClick={handleSelectAll} disabled={isDownloading} className='hover:text-primary'>
          {_('Select All')}
        </button>
        <div className='divider divider-horizontal mx-0'></div>
        <button onClick={handleSelectNone} disabled={isDownloading} className='hover:text-primary'>
          {_('None')}
        </button>
        <div className='divider divider-horizontal mx-0'></div>
        <button
          onClick={handleSelectMissing}
          disabled={isDownloading}
          className='hover:text-primary'
        >
          {_('Missing')}
        </button>
        <div className='divider divider-horizontal mx-0'></div>
        <button
          onClick={handleSelectUnread}
          disabled={isDownloading}
          className='hover:text-primary'
        >
          {_('Unread')}
        </button>
      </div>
      {/* LIST */}
      <div className='flex-1 overflow-y-auto p-0'>
        <ul className='menu menu-sm w-full p-0'>
          {flatTOC.map(({ item, depth }, index) => {
            const href = item.href || '';
            const isDownloaded = downloadedHrefs.has(href);
            const isSelected = selection.has(href);
            const isActive = downloadingHref === href;
            const isCurrent = currentSectionHref === href;

            return (
              <li key={href} ref={isCurrent ? currentChapterRef : null}>
                <label
                  className={clsx(
                    'flex h-auto cursor-pointer items-center justify-between rounded-none py-3 pr-4',
                    isSelected && 'bg-base-200',
                    isCurrent && 'bg-primary/10 border-l-primary border-l-4',
                  )}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault();
                      handleToggleSelection(href, index, true);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      // Normal toggle for keyboard
                      handleToggleSelection(href, index);
                    }
                  }}
                >
                  <div className='flex items-center gap-3 overflow-hidden'>
                    {/* Checkbox */}
                    <input
                      type='checkbox'
                      className='checkbox checkbox-sm checkbox-primary'
                      checked={isSelected}
                      onChange={() => {
                        // We handle shiftKey in label.onClick.
                        // If it's a normal click/keyboard toggle, we handle it here.
                        handleToggleSelection(href, index);
                      }}
                      disabled={isDownloading}
                    />

                    <span className='truncate' style={{ paddingLeft: `${depth * 12}px` }}>
                      {item.label || href}
                    </span>
                    {isCurrent && (
                      <span className='badge badge-primary badge-xs py-2 uppercase tracking-wide opacity-80'>
                        {_('Current')}
                      </span>
                    )}
                  </div>

                  {/* Status Icon */}
                  <div className='flex-shrink-0'>
                    {isActive ? (
                      <span className='loading loading-spinner loading-xs text-primary'></span>
                    ) : isDownloaded ? (
                      <MdDownload className='text-lg opacity-50' />
                    ) : (
                      <div className='border-base-300 h-4 w-4 rounded-full border-2'></div>
                    )}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
      {/* FOOTER */}
      <div className='border-base-200 flex-shrink-0 border-t p-4'>
        {/* Voice Change Confirm */}
        {showVoiceConfirm && (
          <div className='alert alert-warning mb-2 p-2 text-xs'>
            <span>{_('Changing voice will delete existing audio.')}</span>
            <div className='mt-1 flex gap-2'>
              <button onClick={startDownloadBatch} className='btn btn-xs btn-error'>
                {_('Proceed')}
              </button>
              <button onClick={() => setShowVoiceConfirm(false)} className='btn btn-xs btn-ghost'>
                {_('Cancel')}
              </button>
            </div>
          </div>
        )}

        {isDownloading ? (
          <div className='flex flex-col gap-2'>
            {downloadProgress && (
              <div className='mb-1 flex w-full flex-col'>
                <div className='mb-1 flex justify-between text-xs opacity-80'>
                  <span>{_('Downloading...')}</span>
                  <span className='font-mono'>
                    {Math.round(
                      (downloadProgress.downloadedSections / downloadProgress.totalSections) * 100,
                    )}
                    %
                  </span>
                </div>
                <progress
                  className='progress progress-primary w-full'
                  value={downloadProgress.downloadedSections}
                  max={downloadProgress.totalSections}
                ></progress>
              </div>
            )}
            {!downloadProgress && (
              <div className='flex flex-1 animate-pulse items-center justify-center text-sm font-medium'>
                {_('Processing...')}
              </div>
            )}

            <div className='flex justify-end gap-2'>
              <button onClick={handleCancel} className='btn btn-error btn-sm w-full'>
                {_('Cancel')}
              </button>
            </div>
          </div>
        ) : error ? (
          <div className='flex flex-col gap-2'>
            <div className='alert alert-error px-2 py-2 text-xs'>{error}</div>
            <button
              onClick={() => {
                setError(null);
                offlineAudioManager.clearError(bookId);
              }}
              className='btn btn-primary btn-sm w-full'
            >
              {_('Continue')}
            </button>
          </div>
        ) : (
          <div className='flex gap-2'>
            <button
              onClick={handleDownloadSelected}
              disabled={isSelectionEmpty || !hasMissingInSelection}
              className='btn btn-primary btn-sm flex-1'
            >
              <MdDownload />
              {_('Download')} ({downloadCount})
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={isSelectionEmpty || !hasDownloadedInSelection}
              className='btn btn-outline btn-error btn-sm w-1/3'
            >
              <MdDelete />
              {_('Delete')} ({deleteCount})
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default OfflineAudioDownload;
