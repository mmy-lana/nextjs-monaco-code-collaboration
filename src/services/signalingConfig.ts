import type { SignalingConfig } from '@/types/collaboration';

export const DEFAULT_SIGNALING: SignalingConfig = {
  servers: typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? ['wss://localhost:4444']
    : ['ws://localhost:4444'],
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};
