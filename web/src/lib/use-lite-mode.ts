'use client';

import { useEffect, useState } from 'react';

/** `?lite=1` (or NEXT_PUBLIC_LITE_MODE=1) hides the 3D viewer for the robot's 7" screen. */
export function useLiteMode(): boolean {
  const [isLite, setIsLite] = useState(process.env.NEXT_PUBLIC_LITE_MODE === '1');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('lite') === '1' || process.env.NEXT_PUBLIC_LITE_MODE === '1') {
      setIsLite(true);
      return;
    }
    try {
      window.localStorage.removeItem('ROSORIN_LITE_MODE');
    } catch (err) {
      console.warn('[lite] localStorage no disponible:', err);
    }
    setIsLite(false);
  }, []);

  return isLite;
}
