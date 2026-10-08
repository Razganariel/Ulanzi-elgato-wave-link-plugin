/**
 * Mix Mute property inspector.
 */
(function () {
  const mixSelect = PI.el('mix');

  PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      if (payload.mixes) {
        PI.fillSelect(mixSelect, payload.mixes, payload.mixId, PI.mixBlank(payload.mixes.length, false));
      }
    },
  });
})();
