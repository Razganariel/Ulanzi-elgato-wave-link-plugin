/**
 * Channel Mute property inspector.
 */
(function () {
  const channelSelect = PI.el('channel');
  const mixSelect = PI.el('mix');

  PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      if (payload.channels) {
        PI.fillSelect(channelSelect, payload.channels, payload.channelId, PI.channelBlank(payload.channels.length));
      }
      if (payload.mixes) {
        PI.fillSelect(mixSelect, payload.mixes, payload.mixId, PI.mixBlank(payload.mixes.length, true));
      }
    },
  });
})();