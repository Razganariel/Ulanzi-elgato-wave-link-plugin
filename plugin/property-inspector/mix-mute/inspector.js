/**
 * Mix Mute property inspector.
 */

(function () {
  const mixSelect = PI.el('mix');

  PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      if (payload.mixes) updateMixes(payload.mixes, payload.mixId);
    },
  });

  function updateMixes(mixes, selectedId) {
    mixSelect.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = mixes.length ? 'Default mix' : 'No mix found';
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