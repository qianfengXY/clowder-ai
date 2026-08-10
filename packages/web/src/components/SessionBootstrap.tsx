'use client';

import { useEffect } from 'react';
import { ensureApiSession } from '@/utils/api-client';

let established = false;

export function SessionBootstrap() {
  useEffect(() => {
    if (established) return;
    established = true;
    void ensureApiSession().catch(() => {});
  }, []);
  return null;
}
