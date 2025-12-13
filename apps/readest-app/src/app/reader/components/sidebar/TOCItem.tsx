import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ListChildComponentProps } from 'react-window';
import { MdCheckCircle, MdDownload, MdDelete, MdAccessTime } from 'react-icons/md';
import { TOCItem } from '@/libs/document';
import { getContentMd5 } from '@/utils/misc';
import ContextMenu from '@/components/ContextMenu';

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
  isDownloading?: boolean;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
  onDownloadSection?: (item: TOCItem) => void;
  onDeleteSection?: (item: TOCItem) => void;
}>(({ flatItem, itemSize, isActive, isDownloaded, isDownloading, onToggleExpand, onItemClick, onDownloadSection, onDeleteSection }) => {
  const { item, depth } = flatItem;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const touchStartTimeRef = React.useRef<number>(0);
  const touchStartPosRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPressTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const itemRef = useRef<HTMLDivElement | null>(null);

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
      event.preventDefault();
      onItemClick(item);
    },
    [item, onItemClick],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!item.href || (!onDownloadSection && !onDeleteSection)) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [item.href, onDownloadSection, onDeleteSection],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!item.href || (!onDownloadSection && !onDeleteSection)) return;
      touchStartTimeRef.current = Date.now();
      const touch = e.touches[0];
      if (touch) {
        touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
      }
      
      // Set up long press detection
      longPressTimeoutRef.current = setTimeout(() => {
        if (touch) {
          setContextMenu({ x: touch.clientX, y: touch.clientY });
        }
      }, 500);
    },
    [item.href, onDownloadSection, onDeleteSection],
  );

  const handleTouchEnd = useCallback(
    () => {
      // Clear the long press timeout if touch ends before 500ms
      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
        longPressTimeoutRef.current = null;
      }
    },
    [],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      // Cancel long press if user moves touch significantly
      const touch = e.touches[0];
      if (touch) {
        const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
        const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
        const moveThreshold = 10; // pixels
        
        if (dx > moveThreshold || dy > moveThreshold) {
          if (longPressTimeoutRef.current) {
            clearTimeout(longPressTimeoutRef.current);
            longPressTimeoutRef.current = null;
          }
        }
      }
    },
    [],
  );

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onDownloadSection) {
        onDownloadSection(item);
      }
      setContextMenu(null);
    },
    [item, onDownloadSection],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onDeleteSection) {
        onDeleteSection(item);
      }
      setContextMenu(null);
    },
    [item, onDeleteSection],
  );

  useEffect(() => {
    if (!contextMenu) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      // Check if click/touch is outside the context menu and the triggering item
      if (contextMenuRef.current && itemRef.current) {
        const contextMenuElement = contextMenuRef.current.querySelector('ul');
        if (
          contextMenuElement &&
          !contextMenuElement.contains(e.target as Node) &&
          !itemRef.current.contains(e.target as Node)
        ) {
          setContextMenu(null);
        }
      }
    };

    const handleTouchMoveDismiss = (e: TouchEvent) => {
      // Allow small finger drift; dismiss only after noticeable movement
      const touch = e.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
      const moveThreshold = 30; // pixels
      if (dx > moveThreshold || dy > moveThreshold) {
        setContextMenu(null);
      }
    };

    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('touchend', handleOutsideClick);
    document.addEventListener('touchmove', handleTouchMoveDismiss, { passive: true });

    return () => {
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('touchend', handleOutsideClick);
      document.removeEventListener('touchmove', handleTouchMoveDismiss);
    };
  }, [contextMenu]);

  return (
    <>
      <div
        ref={itemRef}
        tabIndex={0}
        role='treeitem'
        onClick={item.href ? handleClickItem : undefined}
        onKeyDown={item.href ? (e) => e.key === 'Enter' && handleClickItem(e) : undefined}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
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
      {isDownloading && (
        <MdAccessTime 
          className='text-warning ms-2 flex-shrink-0 animate-spin' 
          title='Downloading audio'
          size={16}
        />
      )}
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
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
          >
            {!isDownloaded && onDownloadSection && (
              <li>
                <button onClick={handleDownload} className='flex items-center gap-2'>
                  <MdDownload size={16} />
                  <span>Download Audio</span>
                </button>
              </li>
            )}
            {isDownloaded && onDeleteSection && (
              <li>
                <button onClick={handleDelete} className='flex items-center gap-2 text-error'>
                  <MdDelete size={16} />
                  <span>Delete Audio</span>
                </button>
              </li>
            )}
          </ContextMenu>
        </div>
      )}
    </>
  );
});

TOCItemView.displayName = 'TOCItemView';
interface ListRowProps {
  bookKey: string;
  flatItem: FlatTOCItem;
  itemSize?: number;
  activeHref: string | null;
  downloadedHrefs?: Set<string>;
  downloadingHrefs?: Set<string>;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
  onDownloadSection?: (item: TOCItem) => void;
  onDeleteSection?: (item: TOCItem) => void;
}

export const StaticListRow: React.FC<ListRowProps> = ({
  bookKey,
  flatItem,
  itemSize,
  activeHref,
  downloadedHrefs,
  downloadingHrefs,
  onToggleExpand,
  onItemClick,
  onDownloadSection,
  onDeleteSection,
}) => {
  const isActive = activeHref === flatItem.item.href;
  const isDownloaded = downloadedHrefs?.has(flatItem.item.href) || false;
  const isDownloading = downloadingHrefs?.has(flatItem.item.href) || false;


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
        isDownloading={isDownloading}
        onToggleExpand={onToggleExpand}
        onItemClick={onItemClick}
        onDownloadSection={onDownloadSection}
        onDeleteSection={onDeleteSection}
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
      downloadingHrefs?: Set<string>;
      onToggleExpand: (item: TOCItem) => void;
      onItemClick: (item: TOCItem) => void;
      onDownloadSection?: (item: TOCItem) => void;
      onDeleteSection?: (item: TOCItem) => void;
    };
  }
> = ({ index, style, data }) => {
  const {
    flatItems,
    bookKey,
    activeHref,
    itemSize,
    downloadedHrefs,
    downloadingHrefs,
    onToggleExpand,
    onItemClick,
    onDownloadSection,
    onDeleteSection,
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
        downloadingHrefs={downloadingHrefs}
        onToggleExpand={onToggleExpand}
        onItemClick={onItemClick}
        onDownloadSection={onDownloadSection}
        onDeleteSection={onDeleteSection}
      />
    </div>
  );
};
