'use client';

import { useEffect, useState } from 'react';
import {
  API_KEY_UPDATED_EVENT,
  getApiKeySource,
  getBridgeKeyStatus,
  type ApiKeySource,
  type BridgeKeyStatus,
} from './api-key';
import { apiKeyGateState, type ApiKeyGateState } from './api-key-gate';

export interface ApiKeyGateInfo {
  state: ApiKeyGateState;
  source: ApiKeySource;
  bridgeStatus: BridgeKeyStatus;
}

/** Live view of whether the page has a Gemini key (bridge or typed), re-rendering on changes. */
export function useApiKeyGate(): ApiKeyGateInfo {
  const [info, setInfo] = useState<ApiKeyGateInfo>({ state: 'loading', source: 'none', bridgeStatus: 'idle' });

  useEffect(() => {
    const sync = () => {
      const source = getApiKeySource();
      const bridgeStatus = getBridgeKeyStatus();
      setInfo({ state: apiKeyGateState(source, bridgeStatus), source, bridgeStatus });
    };
    sync();
    window.addEventListener(API_KEY_UPDATED_EVENT, sync);
    return () => window.removeEventListener(API_KEY_UPDATED_EVENT, sync);
  }, []);

  return info;
}
