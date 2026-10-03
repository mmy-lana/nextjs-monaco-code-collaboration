export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export function isApplePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  return /Mac|iPhone|iPod|iPad/.test(navigator.platform);
}
