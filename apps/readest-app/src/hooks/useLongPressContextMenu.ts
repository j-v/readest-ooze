import { useCallback, useEffect, useRef, useState } from 'react';

export interface LongPressContextMenuOptions {
  disabled?: boolean;
  longPressMs?: number;
  moveThreshold?: number;
}

export interface MenuCoords {
  x: number;
  y: number;
}

export const useLongPressContextMenu = (
  options: LongPressContextMenuOptions = {},
) => {
  const { disabled = false, longPressMs = 500, moveThreshold = 30 } = options;

  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPressTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const menuClosedAtRef = useRef<number>(0);

  const clearLongPressTimeout = useCallback(() => {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }, []);

  const openMenu = useCallback(
    (x: number, y: number) => {
      setCoords({ x, y });
    },
    [],
  );

  const closeMenu = useCallback(() => {
    menuClosedAtRef.current = Date.now();
    setCoords(null);
    clearLongPressTimeout();
  }, [clearLongPressTimeout]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    },
    [disabled, openMenu],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return;
      const touch = e.touches[0];
      if (!touch) return;
      touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
      clearLongPressTimeout();
      longPressTimeoutRef.current = setTimeout(() => {
        openMenu(touchStartPosRef.current.x, touchStartPosRef.current.y);
      }, longPressMs);
    },
    [disabled, longPressMs, openMenu, clearLongPressTimeout],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
      if (dx > moveThreshold || dy > moveThreshold) {
        clearLongPressTimeout();
      }
    },
    [disabled, moveThreshold, clearLongPressTimeout],
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPressTimeout();
  }, [clearLongPressTimeout]);

  const wrapMenuAction = useCallback(
    <T extends React.MouseEvent | React.TouchEvent>(
      handler: (e: T) => void,
    ) => {
      return (e: T) => {
        e.preventDefault();
        e.stopPropagation();
        handler(e);
        closeMenu();
      };
    },
    [closeMenu],
  );

  const shouldPreventClick = useCallback(() => {
    // Prevent click if context menu was just closed (within 300ms)
    const timeSinceMenuClose = Date.now() - menuClosedAtRef.current;
    return timeSinceMenuClose < 300;
  }, []);

  useEffect(() => {
    if (disabled) {
      closeMenu();
      return;
    }
  }, [disabled, closeMenu]);

  useEffect(() => {
    if (!coords || disabled) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && triggerRef.current) {
        const target = e.target as Node;
        if (!menuRef.current.contains(target) && !triggerRef.current.contains(target)) {
          closeMenu();
        }
      }
    };

    const handleTouchMoveDismiss = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
      if (dx > moveThreshold || dy > moveThreshold) {
        closeMenu();
      }
    };

    const touchOptions: AddEventListenerOptions = { passive: true };

    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('touchend', handleOutsideClick);
    document.addEventListener('touchmove', handleTouchMoveDismiss, touchOptions);

    return () => {
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('touchend', handleOutsideClick);
      document.removeEventListener('touchmove', handleTouchMoveDismiss);
    };
  }, [coords, disabled, closeMenu, moveThreshold]);

  return {
    coords,
    isOpen: !!coords,
    openMenu,
    closeMenu,
    triggerRef,
    menuRef,
    wrapMenuAction,
    shouldPreventClick,
    triggerProps: {
      onContextMenu: handleContextMenu,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    triggerStyle: {
      pointerEvents: coords ? ('none' as const) : ('auto' as const),
    },
  } as const;
};
