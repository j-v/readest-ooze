import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, onClose, children }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const touchOptions: AddEventListenerOptions = { passive: true };

    document.addEventListener('mousedown', handlePointerOutside);
    document.addEventListener('touchstart', handlePointerOutside, touchOptions);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerOutside);
      document.removeEventListener('touchstart', handlePointerOutside, touchOptions);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className='bg-base-100 border-base-300 fixed min-w-[160px] rounded-lg border shadow-lg'
      style={{
        left: `${x}px`,
        top: `${y}px`,
        zIndex: 9999,
        position: 'fixed',
      }}
    >
      <ul className='menu menu-sm p-2'>{children}</ul>
    </div>,
    document.body,
  );
};

export default ContextMenu;
