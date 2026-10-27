'use client';

import { useEffect } from 'react';
import { getApiKeySource } from '@/lib/api-key';

/**
 * Mounted once in the root layout: on every page load it purges any Gemini key an older version
 * left in browser storage and starts fetching the key from the bridge (memory only).
 */
export function ApiKeyBoot() {
  useEffect(() => {
    getApiKeySource();
  }, []);
  return null;
}
