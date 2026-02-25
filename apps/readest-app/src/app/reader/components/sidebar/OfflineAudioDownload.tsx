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
import { useLongPress } from '@/hooks/useLongPress';

interface OfflineAudioDownloadProps {
  bookKey: string;
  onClose?: () => void;
}

interface TOCDownloadItemProps {
  item: TOCItem;
  depth: number;
  index: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isActive: boolean;
  isCurrent: boolean;
  isDownloading: boolean;
  onToggle: (href: string, index: number, isShift?: boolean) => void;
  innerRef?: React.Ref<HTMLLIElement>;
}

const TOCDownloadItem: React.FC<TOCDownloadItemProps> = ({
  item,
  depth,
  index,
  isSelected,
  isDownloaded,
  isActive,
  isCurrent,
  isDownloading,
  onToggle,
  innerRef,
}) => {
  const _ = useTranslation();
  const href = item.href || '';

  const { handlers, pressing } = useLongPress(
    {
      onTap: (e) => onToggle(href, index, e?.shiftKey),
      onLongPress: () => onToggle(href, index, true),
    },
    [href, index, onToggle],
  );

  return (
    <li ref={innerRef}>
      <div
        role='button'
        className={clsx(
          'focus:bg-base-300 flex h-auto cursor-pointer items-center rounded-none py-3 pr-4 outline-none transition-colors',
          isSelected && 'bg-base-200',
          isCurrent && 'bg-primary/10 border-l-primary border-l-4',
          pressing && 'bg-base-300',
        )}
        {...handlers}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(href, index);
          }
        }}
        tabIndex={0}
      >
        <div className='flex items-center gap-3 overflow-hidden'>
          <input
            type='checkbox'
            className='checkbox checkbox-sm checkbox-primary pointer-events-none'
            checked={isSelected}
            readOnly
            disabled={isDownloading}
          />

          <div className='flex-shrink-0'>
            {isActive ? (
              <span className='loading loading-spinner loading-xs text-primary'></span>
            ) : isDownloaded ? (
              <MdDownload className='text-lg opacity-50' />
            ) : (
              <></>
            )}
          </div>

          <span className='truncate' style={{ paddingLeft: `${depth * 12}px` }}>
            {item.label || href}
          </span>
          {isCurrent && (
            <span className='badge badge-primary badge-xs py-2 uppercase tracking-wide opacity-80'>
              {_('Current')}
            </span>
          )}
        </div>
      </div>
    </li>
  );
};

const OfflineAudioDownload: React.FC<OfflineAudioDownloadProps> = ({ bookKey, onClose }) => {
  const _ = useTranslation();
  const { getViewSettings, getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();

  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalSize, setTotalSize] = useState<number>(0);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Selection State
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [downloadedHrefs, setDownloadedHrefs] = useState<Set<string>>(new Set());
  const [downloadingHref, setDownloadingHref] = useState<string | null>(null);
  const [pivotIndex, setPivotIndex] = useState<number | null>(null);

  // Voice selection state
  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [downloadedVoiceId, setDownloadedVoiceId] = useState<string | null>(null);

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
        if (status.progress.sectionHrefs) {
          setSelection(new Set(status.progress.sectionHrefs));
        }
      } else if (
        !status.inProgress &&
        status.progress?.lastError &&
        status.progress.lastError !== 'Download cancelled'
      ) {
        setError('Failed to download audio, check your network connection');
      }

      const dHrefs = await offlineAudioManager.getAllDownloadedSections(bookId);
      setDownloadedHrefs(dHrefs);

      const size = await offlineAudioManager.getTotalSize(bookId);
      setTotalSize(size);
    } catch (err) {
      console.error('Error loading offline audio status:', err);
    }
  }, [bookId]);

  // Voice Loading & Selection Logic
  useEffect(() => {
    let isMounted = true;
    const loadVoicesAndSetDefault = async () => {
      if (!bookDoc) return;
      await loadStatus();
      if (!isMounted) return;

      // Determine active chapter for voice context
      const firstSelectionHref = Array.from(selection)[0];
      const activeHref = firstSelectionHref || currentSectionHref || flatTOC[0]?.item?.href;

      let chapterVoiceId: string | null = null;
      if (activeHref) {
        chapterVoiceId = await offlineAudioManager.getDownloadedVoiceForSection(bookId, activeHref);
      }

      const bookDownloadedVoiceId = await offlineAudioManager.getDownloadedVoice(bookId);

      // 1. Get current language context
      const groups = await offlineAudioManager.getVoices(ttsLang);
      if (!isMounted) return;
      setVoiceGroups(groups);

      // 2. Set initial stable voice if not yet selected or if current selection is invalid
      setSelectedVoiceId((prev) => {
        const allVoices = groups.flatMap((g) => g.voices);
        const isValid = (id: string | null | undefined) =>
          !!id && allVoices.some((v) => v.id === id);

        // A. Keep current selection if it's still valid for this context
        if (isValid(prev)) return prev;

        // B. Chapter-specific downloaded voice (highest context priority)
        if (isValid(chapterVoiceId)) return chapterVoiceId!;

        // C. Last downloaded voice for the book (consistency priority)
        if (isValid(bookDownloadedVoiceId)) return bookDownloadedVoiceId!;

        // D. Reader settings (user preference priority)
        if (isValid(viewSettings?.ttsVoice)) return viewSettings!.ttsVoice!;

        // E. System preference (global preference priority)
        const preferredClient = TTSUtils.getPreferredClient();
        if (preferredClient) {
          const globalVoice = TTSUtils.getPreferredVoice(preferredClient, ttsLang);
          if (isValid(globalVoice)) return globalVoice!;
        }

        // F. First available voice from preferred engine (http/kokoro)
        const engineFallback =
          groups.find((g) => g.id === 'http-tts')?.voices[0]?.id || groups[0]?.voices[0]?.id;

        if (engineFallback) return engineFallback;

        // G. Hardcoded absolute fallback
        return 'en-US-AriaNeural';
      });
      setIsInitialized(true);
    };

    loadVoicesAndSetDefault();

    return () => {
      isMounted = false;
    };
  }, [
    bookDoc,
    bookId,
    ttsLang,
    selection,
    currentSectionHref,
    downloadedVoiceId,
    viewSettings,
    loadStatus,
    flatTOC,
  ]);

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

    const onSectionComplete = (event: Event) => {
      const { bookHash, href } = (event as CustomEvent).detail;
      if (bookHash === bookId) {
        setDownloadedHrefs((prev) => {
          const next = new Set(prev);
          next.add(href);
          return next;
        });
        setDownloadingHref(null);
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

    offlineAudioManager.addEventListener('download-progress', onDownloadProgress);
    offlineAudioManager.addEventListener('download-complete', onDownloadComplete);
    offlineAudioManager.addEventListener('download-error', onDownloadError);
    offlineAudioManager.addEventListener('section-download-complete', onSectionComplete);
    offlineAudioManager.addEventListener('download-deleted', onDeleted);
    offlineAudioManager.addEventListener('section-download-deleted', onDeleted);

    return () => {
      offlineAudioManager.removeEventListener('download-progress', onDownloadProgress);
      offlineAudioManager.removeEventListener('download-complete', onDownloadComplete);
      offlineAudioManager.removeEventListener('download-error', onDownloadError);
      offlineAudioManager.removeEventListener('section-download-complete', onSectionComplete);
      offlineAudioManager.removeEventListener('download-deleted', onDeleted);
      offlineAudioManager.removeEventListener('section-download-deleted', onDeleted);
    };
  }, [bookId, loadStatus]);

  // Scroll to current chapter
  useEffect(() => {
    if (currentChapterRef.current) {
      currentChapterRef.current.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }, [currentSectionHref, flatTOC.length]);
  const handleToggleSelection = (href: string, index: number, isShift?: boolean) => {
    if (isDownloading) return;
    setSelection((prev) => {
      const next = new Set(prev);
      if (isShift && pivotIndex !== null && flatTOC[pivotIndex]) {
        const start = Math.min(pivotIndex, index);
        const end = Math.max(pivotIndex, index);

        // Use the pivot item's state to determine the target state for the range
        const pivotHref = flatTOC[pivotIndex]?.item?.href || '';
        const shouldSelect = prev.has(pivotHref);

        for (let i = start; i <= end; i++) {
          const h = flatTOC[i]?.item.href;
          if (h) {
            if (shouldSelect) next.add(h);
            else next.delete(h);
          }
        }
      } else {
        if (next.has(href)) {
          next.delete(href);
        } else {
          next.add(href);
        }
      }

      setPivotIndex(index);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (isDownloading) return;
    setSelection(new Set(flatTOC.map((x) => x.item.href || '')));
    setPivotIndex(null);
  };

  const handleSelectNone = () => {
    if (isDownloading) return;
    setSelection(new Set());
    setPivotIndex(null);
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
    setPivotIndex(null);
  };

  const getTTSTargetLang = useCallback((): string | undefined => {
    const ttsReadAloudText = viewSettings?.ttsReadAloudText;
    if (viewSettings?.translationEnabled && ttsReadAloudText === 'translated') {
      return viewSettings?.translateTargetLang || getLocale();
    } else if (viewSettings?.translationEnabled && ttsReadAloudText === 'source') {
      const bData = getBookData(bookKey);
      return bData?.book?.primaryLanguage || '';
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
    startDownloadBatch();
  };

  const startDownloadBatch = async () => {
    setError(null);
    setIsDownloading(true);

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
    // logic in old component did this.
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

    setIsDownloading(true);
    try {
      await offlineAudioManager.deleteSections(bookId, toDelete);
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
    setIsDownloading(false);
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

  const isSelectionEmpty = selection.size === 0;
  const hasMissingInSelection = Array.from(selection).some((h) => !downloadedHrefs.has(h));
  const hasDownloadedInSelection = Array.from(selection).some((h) => downloadedHrefs.has(h));

  const downloadCount = Array.from(selection).filter((h) => !downloadedHrefs.has(h)).length;
  const deleteCount = Array.from(selection).filter((h) => downloadedHrefs.has(h)).length;

  return (
    <div className='bg-base-100 border-base-200 flex h-[80vh] max-h-[600px] w-full max-w-md flex-col rounded-lg border shadow-lg'>
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

        <div className='mb-2 flex items-center justify-between text-xs opacity-70'>
          <span>
            {downloadedHrefs.size} / {flatTOC.length} {_('Downloaded')} ({formatSize(totalSize)})
          </span>
        </div>

        <details ref={voiceDropdownRef} className='dropdown dropdown-bottom w-full'>
          <summary
            className={clsx(
              'btn btn-sm btn-outline w-full justify-between',
              (isDownloading || !isInitialized) && 'btn-disabled',
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
          onClick={handleSelectUnread}
          disabled={isDownloading}
          className='hover:text-primary'
        >
          {_('Unread')}
        </button>
      </div>

      <div className='flex-1 overflow-y-auto p-0'>
        <ul className='menu menu-sm w-full p-0'>
          {flatTOC.map(({ item, depth }, index) => (
            <TOCDownloadItem
              key={item.href || index}
              item={item}
              depth={depth}
              index={index}
              isSelected={selection.size === 0 ? false : selection.has(item.href || '')}
              isDownloaded={downloadedHrefs.has(item.href || '')}
              isActive={downloadingHref === item.href}
              isCurrent={currentSectionHref === item.href}
              isDownloading={isDownloading}
              onToggle={handleToggleSelection}
              innerRef={currentSectionHref === item.href ? currentChapterRef : undefined}
            />
          ))}
        </ul>
      </div>
      {/* FOOTER */}
      <div className='border-base-200 flex-shrink-0 border-t p-4'>
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
              disabled={!isInitialized || isSelectionEmpty || !hasMissingInSelection}
              className='btn btn-primary btn-sm flex-1'
            >
              <MdDownload />
              {_('Download')} ({downloadCount})
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={!isInitialized || isSelectionEmpty || !hasDownloadedInSelection}
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
