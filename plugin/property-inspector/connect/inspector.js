/**
 * Connect property inspector.
 */
(function () {
  const connectBtn = PI.el('connect-btn');
  const refreshBtn = PI.el('refresh-btn');
  const debugEl = PI.el('debug');
  /** How many lines the debug box keeps; it is a diagnostic, not a log file. */
  const MAX_LINES = 40;

  function logDebug(msg) {
    const time = new Date().toLocaleTimeString();
    const lines = debugEl.textContent.split('\n');
    lines.unshift(`[${time}] ${msg}`);
    debugEl.textContent = lines.slice(0, MAX_LINES).join('\n');
  }

  // The state and error messages arrive through the hooks bootForm already installs.
  // This panel used to register a second onSendToPropertyInspector of its own, which
  // meant two listeners on the same message for no gain and a second place to keep in
  // step with the protocol.
  PI.boot('#property-inspector', {
    onState(payload) {
      PI.status(PI.el('conn-status'), payload.state?.connected ? 'connected' : 'disconnected');
      PI.setText('info', payload.state?.connected
        ? `Connected - ${payload.state?.channels?.length || 0} channels, ${payload.state?.mixes?.length || 0} mixes`
        : 'Not connected to Wave Link');
      if (payload.channels) logDebug(`Channels: ${payload.channels.length}`);
      if (payload.mixes) logDebug(`Mixes: ${payload.mixes.length}`);
    },
    onError(message) {
      logDebug(`Error: ${message}`);
    },
  });

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

  $UD.on('connected', () => {
    logDebug('Property inspector connected to UlanziStudio');
  });
})();
