/**
 * Mix Volume property inspector.
 *
 * This action acts on a mix and nothing else, so there is no "overall" fallback to
 * offer: the empty option is only the state of "nothing chosen yet", and turning the
 * dial in that state raises a message on the deck rather than doing nothing quietly.
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