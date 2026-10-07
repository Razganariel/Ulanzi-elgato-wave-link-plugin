/**
 * Connect property inspector.
 */

(function () {
  const connectBtn = PI.el('connect-btn');
  const refreshBtn = PI.el('refresh-btn');
  const debugEl = PI.el('debug');

  const inspector = PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      PI.setText('info', payload.state?.connected
        ? `Connected - ${payload.state?.channels?.length || 0} channels, ${payload.state?.mixes?.length || 0} mixes`
        : 'Not connected to Wave Link');
    },
  });

  function logDebug(msg) {
    const time = new Date().toLocaleTimeString();
    debugEl.textContent = `[${time}] ${msg}\n` + debugEl.textContent;
  }

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    try {
      await $UD.sendToPlugin({ event: 'connect' });
      logDebug('Connect requested');
    } catch (err) {
      logDebug(`Connect error: ${err.message}`);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  });

  refreshBtn.addEventListener('click', () => {
    $UD.sendToPlugin({ event: 'get-registry' });
    logDebug('Registry refresh requested');
  });

  $UD.onSendToPropertyInspector((message) => {
    const payload = message.payload || {};
    if (payload.event === 'state') {
      if (payload.channels) logDebug(`Channels: ${payload.channels.length}`);
      if (payload.mixes) logDebug(`Mixes: ${payload.mixes.length}`);
    }
    if (payload.event === 'error') {
      logDebug(`Error: ${payload.message}`);
    }
  });

  $UD.on('connected', () => {
    logDebug('Property inspector connected to UlanziStudio');
  });
})();