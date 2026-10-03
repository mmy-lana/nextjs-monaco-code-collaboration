'use client';

import { useState, useEffect } from 'react';

export interface ViewportState {
  width: number;
  height: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  keyboardOpen: boolean;
  keyboardHeight: number;
}

export function useResponsiveLayout(): ViewportState {
  const [viewport, setViewport] = useState<ViewportState>({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    keyboardOpen: false,
    keyboardHeight: 0,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => {
      const vv = window.visualViewport;
      const width = vv ? vv.width : window.innerWidth;
      const height = vv ? vv.height : window.innerHeight;
      const windowHeight = window.innerHeight;

      const keyboardHeight = Math.max(0, windowHeight - height);
      const keyboardOpen = keyboardHeight > 150;

      document.documentElement.style.setProperty('--vh', `${height * 0.01}px`);
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      document.documentElement.style.setProperty(
        '--keyboard-bar-height',
        keyboardOpen ? '40px' : '0px'
      );
      document.documentElement.style.setProperty('--statusbar-height', '24px');

      setViewport({
        width,
        height,
        isMobile: width < 768,
        isTablet: width >= 768 && width < 1024,
        isDesktop: width >= 1024,
        keyboardOpen,
        keyboardHeight,
      });
    };

    handleResize();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
    } else {
      window.addEventListener('resize', handleResize);
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      } else {
        window.removeEventListener('resize', handleResize);
      }
    };
  }, []);

  return viewport;
}
