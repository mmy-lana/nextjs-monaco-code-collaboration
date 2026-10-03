const PEER_COLORS = [
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#4ade80',
  '#34d399',
  '#22d3ee',
  '#60a5fa',
  '#818cf8',
  '#c084fc',
  '#f472b6',
];

export function getPeerColor(clientId: number): string {
  const index = Math.abs(clientId) % PEER_COLORS.length;
  return PEER_COLORS[index];
}

export function generateRandomUsername(): string {
  const adjectives = ['Swift', 'Agile', 'Bright', 'Clever', 'Quiet', 'Wired', 'Hyper', 'Sonic'];
  const nouns = ['Coder', 'Hacker', 'Builder', 'Dev', 'Engineer', 'Architect', 'Scripter'];
  const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randNum = Math.floor(100 + Math.random() * 900);
  return `${randAdj}${randNoun}#${randNum}`;
}
