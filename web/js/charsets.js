// Character ramps, always ordered dark -> light: index 0 is what a black cell becomes.

export const CHARSETS = [
  { key: 'standard', label: 'Standard', chars: ' .:-=+*#%@' },
  { key: 'detailed', label: 'Detailed (70)', chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { key: 'blocks', label: 'Blocks', chars: ' ░▒▓█' },
  { key: 'blocks-fine', label: 'Blocks (fine)', chars: ' ▁▂▃▄▅▆▇█' },
  { key: 'minimal', label: 'Minimal', chars: ' .:*#@' },
  { key: 'binary', label: 'Binary', chars: ' 01' },
  { key: 'dots', label: 'Dots', chars: ' ·∶⁙⁘⠿⡇⣿' },
  { key: 'shapes', label: 'Shapes', chars: ' ·○●■◆█' },
  { key: 'ascii-art', label: 'Classic art', chars: ' .,:;i1tfLCG08@' },
  { key: 'hash', label: 'Hash', chars: ' -=#' },
  { key: 'custom', label: 'Custom…', chars: ' .:-=+*#%@' },
];

export const DEFAULT_CHARSET = 'standard';

export function findCharset(key) {
  return CHARSETS.find((c) => c.key === key) || CHARSETS[0];
}
