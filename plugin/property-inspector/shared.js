/**
 * Shared property inspector bootstrap: connects to UlanziStudio, hydrates the
 * form from saved settings, and pushes changes back to the main service.
 *
 * Settings are saved through `sendToPlugin` rather than `sendParamFromPlugin`.
 * The host does not read this form: on reopening a key it replays whatever it
 * stored, down to keys this plugin has since removed from the panel. A
 * `sendParamFromPlugin` from here therefore leaves no trace, and the service --
 * which persists through setSettings -- never learns about the edit.
 */
(function () {
  // A property inspector runs in a WebView with no console the user can reach, so
  // a thrown error is otherwise invisible: the panel just looks inert. Surface
  // failures in the page itself.
  //
  // The page also hosts code injected by UlanziStudio, which has its own startup
  // race: it sends on a socket that is still CONNECTING. Blaming the plugin for
  // that would send the user hunting in the wrong place, so it goes to the
  // console. Everything else, including our own bundled SDK, keeps the banner.
  const HOST_NOISE = /Still in CONNECTING state/;

  function reportFatal(what, err) {
    const message = `${what}: ${(err && err.message) || err}`;
    if (HOST_NOISE.test(message)) {
      console.warn(`[wavelink] ignoré (hôte Ulanzi) : ${message}`);
      return;
    }
    let box = document.getElementById('pi-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'pi-error';
      box.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 10px;' +
        'background:#7f1d1d;color:#fff;font:12px/1.4 monospace;white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.textContent = message;
  }
  window.addEventListener('error', (e) => reportFatal('JS error', e.error || e.message));

  function boot(formId, options) {
    const form = document.querySelector(formId);
    if (!form) {
      reportFatal('Form not found', formId);
      return null;
    }
    try {
      return bootForm(form, options);
    } catch (err) {
      reportFatal('Property inspector failed to start', err);
      throw err;
    }
  }

  // Bump when the behaviour below changes: the inspector WebView caches this file
  // while re-reading the HTML, so the version is the only way to tell from the
  // service log which copy of this script a panel is actually running.
  const PI_VERSION = 7;

  /**
   * Reports the form's actual contents to the service whenever they change,
   * independently of the save path.
   *
   * The service log is the only place a value can be observed from outside the
   * WebView, and it distinguishes the two ways a setting can go missing: the typed
   * value never reached the DOM, or it did and was then wiped before being saved.
   * Cheap enough to keep, since it only fires on an actual change.
   */
  let lastReported = null;
  function reportForm(form) {
    const values = Utils.getFormValue(form);
    const flat = {};
    for (const [key, value] of Object.entries(values)) {
      flat[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
    const serialised = JSON.stringify(flat);
    if (serialised === lastReported) return;
    lastReported = serialised;
    try {
      $UD.sendToPlugin({ event: 'pi-form', values: flat });
    } catch {
      /* the panel may be closing */
    }
  }

  function bootForm(form, options) {
    const sendParams = Utils.debounce((params) => $UD.sendToPlugin({ event: 'set-settings', settings: params }), 150);

    $UD.connect(document.body.dataset.actionid);
    const pushForm = () => {
      reportForm(form);
      sendParams(Utils.getFormValue(form));
    };
    form.addEventListener('change', pushForm);
    // `change` alone is not enough for a text field: it only fires on blur, so a
    // label typed and then abandoned -- the user reaching for the physical dial, or
    // the panel closing -- never reaches the service and the dial falls back to the
    // bound channel name. `input` fires per keystroke, and the debounce keeps that
    // from turning into one request per character.
    form.addEventListener('input', pushForm);
    // Closing the panel can tear the WebView down before a pending debounce fires,
    // which loses whatever was typed. focusout is the last reliable moment.
    form.addEventListener('focusout', () => {
      reportForm(form);
      $UD.sendToPlugin({ event: 'set-settings', settings: Utils.getFormValue(form) });
    });

    const applySettings = (settings) => {
      // The host replays its stored settings on every open, and it sends them often.
      // Writing those over a field the user is still typing in would wipe half-typed
      // text, so the element in focus is left alone until they leave it.
      const focused = document.activeElement;
      const skip = focused && focused.form === form ? focused.name : null;
      let applied = settings || {};
      if (skip) {
        const { [skip]: _held, ...rest } = applied;
        applied = rest;
      }
      Utils.setFormValue(applied, form);
      // Some controls (a select, notably) need their value applied after hydration,
      // not just the fields the form knows how to draw. They are told about the fields
      // that were actually applied, not about the whole incoming set: the one the user
      // has hold of is deliberately absent, and a hook that were handed it would put
      // the value back under their cursor.
      if (options.onSettings) options.onSettings(applied);
      // Deliberately no forced re-report. The host replays on every key selection, and
      // resetting the cache made each of those write a pi-form back to the service, for
      // a form that had not changed. reportForm below compares on its own and stays
      // quiet unless something really differs.
      reportForm(form);
    };
    $UD.onParamFromApp((message) => applySettings(message.param));
    $UD.onDidReceiveSettings((message) => applySettings(message.settings));
    $UD.onSendToPropertyInspector((message) => {
      const payload = message.payload || {};
      if (payload.event === 'state' && options.onState) options.onState(payload);
      if (payload.event === 'error' && options.onError) options.onError(payload.message);
    });

    // Wait for WebSocket to be connected before requesting settings.
    // The connect() is async; calling getSettings() immediately fails because
    // the websocket isn't open yet ("object not usable" error).
    $UD.on('connected', () => {
      // Announce ourselves: the service log then records which build of this script
      // the panel is running, which is otherwise invisible when a WebView serves a
      // cached copy and a fix silently does not land.
      $UD.sendToPlugin({ event: 'pi-hello', version: PI_VERSION });
      $UD.getSettings();
      // Also request the device registry (in case we missed the initial broadcast).
      $UD.sendToPlugin({ event: 'get-registry' });
    });

    return { form, sendParams };
  }

  window.PI = {
    el(id) {
      return document.getElementById(id);
    },
    on(id, event, fn) {
      const node = document.getElementById(id);
      if (node) node.addEventListener(event, fn);
      return node;
    },
    setText(id, text) {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    },
    showError(id, message) {
      const node = document.getElementById(id);
      if (!node) return;
      node.textContent = message || '';
      node.style.display = message ? 'block' : 'none';
    },
    status(node, state) {
      if (!node) return;
      const dot = node.querySelector('.dot');
      const label = node.querySelector('.label');
      if (dot) dot.className = `dot ${state === 'connected' ? 'on' : state === 'error' ? 'off' : ''}`;
      if (label) label.textContent = state;
    },

    /**
     * Fills a <select> with the ids and names a panel needs.
     *
     * Four panels each had their own copy of this loop, and a fifth and sixth of the
     * mix one, all of which had to keep the same wording for the empty option -- a
     * Channel Mute panel and a Channel Volume panel offering the same choice must not
     * describe it two different ways. Copy-paste is no way to hold that, so the wording
     * lives here and the panels name it.
     *
     * @param blank  label of the empty option, the state of "nothing chosen"
     */
    fillSelect(select, items, selectedId, blank) {
      select.textContent = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = blank;
      select.appendChild(empty);
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        // textContent, never innerHTML: the names come from Wave Link and a device
        // called <img onerror=...> would otherwise run in this WebView.
        option.textContent = item.name || item.id;
        select.appendChild(option);
      }
      select.value = selectedId || '';
    },

    /** The empty option of a channel picker: a channel always is, or none was found. */
    channelBlank(count) {
      return count ? 'Default channel' : 'No channel found';
    },

    /**
     * The empty option of a mix picker, which means two different things.
     *
     * Where a mix scopes a level -- Channel Volume, and the two one-step buttons -- the
     * empty choice is "the whole channel", and the wording has to say so. Where a mix
     * is the only thing the action can act on, it is simply nothing chosen yet.
     */
    mixBlank(count, optional) {
      if (optional) return 'Overall volume';
      return count ? 'No mix selected' : 'No mix found';
    },

    boot,
  };
})();
