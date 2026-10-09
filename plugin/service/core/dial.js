/**
 * Dial helpers.
 *
 * The host reports rotation as rotateEvent = 'left' | 'right' | 'hold-left' |
 * 'hold-right'. A held rotation is still a rotation in the same direction, so
 * every shipped plugin maps hold-left to -1 and hold-right to +1.
 */

export function rotateSteps(message) {
  const event = message && message.rotateEvent;
  if (event === 'left' || event === 'hold-left') return -1;
  if (event === 'right' || event === 'hold-right') return 1;
  return 0;
}
