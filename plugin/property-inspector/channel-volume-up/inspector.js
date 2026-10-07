/**
 * Channel Volume Up property inspector.
 */

(function () {
  const channelSelect = PI.el('channel');
  const mixSelect = PI.el('mix');

  PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      if (payload.channels) updateChannels(payload.channels, payload.channelId);
      if (payload.mixes) updateMixes(payload.mixes, payload.mixId);
    },
  });

  function updateChannels(channels, selectedId) {
    channelSelect.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = channels.length ? 'Default channel' : 'No channel found';
    channelSelect.appendChild(blank);
    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.name || ch.id;
      channelSelect.appendChild(opt);
    }
    channelSelect.value = selectedId || '';
  }

  function updateMixes(mixes, selectedId) {
    mixSelect.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Overall volume';
    mixSelect.appendChild(blank);
    for (const mix of mixes) {
      const opt = document.createElement('option');
      opt.value = mix.id;
      opt.textContent = mix.name || mix.id;
      mixSelect.appendChild(opt);
    }
    mixSelect.value = selectedId || '';
  }
})();