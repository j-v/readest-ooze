import clsx from 'clsx';
import React, { useCallback } from 'react';
import { ListChildComponentProps } from 'react-window';
import { MdCheckCircle, MdDownload } from 'react-icons/md';
import { TOCItem } from '@/libs/document';
import { getContentMd5 } from '@/utils/misc';
import ContextMenu from '@/components/ContextMenu';
import { useLongPressContextMenu } from '@/hooks/useLongPressContextMenu';

const createExpanderIcon = (isExpanded: boolean) => {
  return (
    <svg
      viewBox='0 0 8 10'
      width='8'
      height='10'
      className={clsx(
        'text-base-content transform transition-transform',
        isExpanded ? 'rotate-90' : 'rotate-0',
      )}
      style={{ transformOrigin: 'center' }}
      fill='currentColor'
    >
      <polygon points='0 0, 8 5, 0 10' />
    </svg>
  );
};

export interface FlatTOCItem {
  item: TOCItem;
  depth: number;
  index: number;
  isExpanded?: boolean;
}

const TOCItemView = React.memo<{
  bookKey: string;
  flatItem: FlatTOCItem;
  itemSize?: number;
  isActive: boolean;
  isDownloaded?: boolean;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
  onOpenOfflineAudioDialog?: (item: TOCItem) => void;
}>(
  ({
    flatItem,
    itemSize,
    isActive,
    isDownloaded,
    onToggleExpand,
    onItemClick,
    onOpenOfflineAudioDialog,
  }) => {
    const { item, depth } = flatItem;
    const {
      coords: contextMenu,
      closeMenu,
      triggerRef: itemRef,
      menuRef: contextMenuRef,
      triggerProps,
      triggerStyle,
      wrapMenuAction,
      shouldPreventClick,
    } = useLongPressContextMenu({
      disabled: !item.href || !onOpenOfflineAudioDialog,
      longPressMs: 500,
      moveThreshold: 30,
    });

    const handleToggleExpand = useCallback(
      (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleExpand(item);
      },
      [item, onToggleExpand],
    );

    const handleClickItem = useCallback(
      (event: React.MouseEvent | React.KeyboardEvent) => {
        if (shouldPreventClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        onItemClick(item);
      },
      [item, onItemClick, shouldPreventClick],
    );

    const handleOpenOfflineAudio = wrapMenuAction(() => {
      if (onOpenOfflineAudioDialog) {
        onOpenOfflineAudioDialog(item);
      }
    });

    return (
      <>
        <div
          ref={itemRef}
          tabIndex={0}
          role='treeitem'
          onClick={item.href ? handleClickItem : undefined}
          onKeyDown={item.href ? (e) => e.key === 'Enter' && handleClickItem(e) : undefined}
          {...triggerProps}
          aria-expanded={flatItem.isExpanded ? 'true' : 'false'}
          aria-selected={isActive ? 'true' : 'false'}
          data-href={item.href ? getContentMd5(item.href) : undefined}
          className={clsx(
            'flex w-full cursor-pointer items-center rounded-md py-4 sm:py-2',
            isActive
              ? 'text-bold-in-eink sm:bg-base-300/65 sm:hover:bg-base-300/75 sm:text-base-content text-blue-500'
              : 'sm:hover:bg-base-300/75',
          )}
          style={{
            height: itemSize ? `${itemSize}px` : 'auto',
            paddingInlineStart: `${(depth + 1) * 12}px`,
            ...triggerStyle,
          }}
        >
          {item.subitems && (
            <button
              onClick={handleToggleExpand}
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
              className='inline-block cursor-pointer'
              style={{
                padding: '12px',
                margin: '-12px',
              }}
            >
              {createExpanderIcon(flatItem.isExpanded || false)}
            </button>
          )}
          <div
            className='ms-2 truncate text-ellipsis'
            style={{
              maxWidth: 'calc(100% - 24px)',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {item.label}
          </div>
          {isDownloaded && (
            <MdCheckCircle
              className='text-success ms-2 flex-shrink-0'
              title='Downloaded for offline listening'
              size={16}
            />
          )}
          {item.location && (
            <div className='text-base-content/50 ms-auto ps-1 text-xs sm:pe-1'>
              {item.location.current + 1}
            </div>
          )}
        </div>

        {contextMenu && (
          <div ref={contextMenuRef}>
            <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={closeMenu}>
              {onOpenOfflineAudioDialog && (
                <li>
                  <button
                    onClick={handleOpenOfflineAudio}
                    onTouchEnd={handleOpenOfflineAudio}
                    className='flex items-center gap-2'
                  >
                    <MdDownload size={16} />
                    <span>Offline Audio...</span>
                  </button>
                </li>
              )}
            </ContextMenu>
          </div>
        )}
      </>
    );
  },
);

TOCItemView.displayName = 'TOCItemView';
interface ListRowProps {
  bookKey: string;
  flatItem: FlatTOCItem;
  itemSize?: number;
  activeHref: string | null;
  downloadedHrefs?: Set<string>;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
  onOpenOfflineAudioDialog?: (item: TOCItem) => void;
}

export const StaticListRow: React.FC<ListRowProps> = ({
  bookKey,
  flatItem,
  itemSize,
  activeHref,
  downloadedHrefs,
  onToggleExpand,
  onItemClick,
  onOpenOfflineAudioDialog,
}) => {
  const isActive = activeHref === flatItem.item.href;
  const isDownloaded = downloadedHrefs?.has(flatItem.item.href) || false;

  return (
    <div
      className={clsx(
        'border-base-300 w-full border-b sm:border-none',
        'pe-4 ps-2 pt-[1px] sm:pe-2',
      )}
      title={flatItem.item.label || ''}
    >
      <TOCItemView
        bookKey={bookKey}
        flatItem={flatItem}
        itemSize={itemSize}
        isActive={isActive}
        isDownloaded={isDownloaded}
        onToggleExpand={onToggleExpand}
        onItemClick={onItemClick}
        onOpenOfflineAudioDialog={onOpenOfflineAudioDialog}
      />
    </div>
  );
};

export const VirtualListRow: React.FC<
  ListChildComponentProps & {
    data: {
      bookKey: string;
      flatItems: FlatTOCItem[];
      itemSize: number;
      activeHref: string | null;
      downloadedHrefs?: Set<string>;
      onToggleExpand: (item: TOCItem) => void;
      onItemClick: (item: TOCItem) => void;
      onOpenOfflineAudioDialog?: (item: TOCItem) => void;
    };
  }
> = ({ index, style, data }) => {
  const {
    flatItems,
    bookKey,
    activeHref,
    itemSize,
    downloadedHrefs,
    onToggleExpand,
    onItemClick,
    onOpenOfflineAudioDialog,
  } = data;
  const flatItem = flatItems[index];

  return (
    <div style={style} title={flatItem.item.label || ''}>
      <StaticListRow
        bookKey={bookKey}
        flatItem={flatItem}
        itemSize={itemSize - 1}
        activeHref={activeHref}
        downloadedHrefs={downloadedHrefs}
        onToggleExpand={onToggleExpand}
        onItemClick={onItemClick}
        onOpenOfflineAudioDialog={onOpenOfflineAudioDialog}
      />
    </div>
  );
};
