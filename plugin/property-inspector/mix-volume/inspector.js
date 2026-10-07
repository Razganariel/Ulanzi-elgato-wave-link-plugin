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
      if (payload.mixes) updateMixes(payload.mixes, payload.mixId);
    },
  });

  function updateMixes(mixes, selectedId) {
    mixSelect.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = mixes.length ? 'No mix selected' : 'No mix found';
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