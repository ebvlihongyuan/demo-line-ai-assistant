(function () {
  'use strict';

  var INSTANCE_KEY = '__demoLineAssistantEmbed__';
  var IFRAME_ID = 'demo-line-assistant-widget-frame';

  // A copied or repeated script tag must not install another iframe/listener.
  if (window[INSTANCE_KEY] || document.getElementById(IFRAME_ID)) return;
  window[INSTANCE_KEY] = true;

  var script = document.currentScript;
  if (!script || !script.src) {
    window[INSTANCE_KEY] = false;
    return;
  }

  var assistantUrl;
  try {
    assistantUrl = new URL(script.src, document.baseURI);
  } catch (error) {
    window[INSTANCE_KEY] = false;
    return;
  }

  var assistantOrigin = assistantUrl.origin;
  var iframe;

  function applySize(isOpen) {
    if (!iframe) return;

    var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    var margin = 16;
    var width;
    var height;

    if (!isOpen) {
      // The launcher contains both an icon and the assistant name.
      width = Math.min(190, Math.max(0, viewportWidth - margin * 2));
      height = 72;
    } else {
      // Keep a clear margin on small screens while limiting desktop dimensions.
      width = Math.min(420, Math.max(0, viewportWidth - margin * 2));
      height = Math.min(640, Math.max(0, viewportHeight - margin * 2));
    }

    iframe.style.width = width + 'px';
    iframe.style.height = height + 'px';
    iframe.style.maxWidth = 'calc(100vw - ' + (margin * 2) + 'px)';
    iframe.style.maxHeight = 'calc(100vh - ' + (margin * 2) + 'px)';
    iframe.dataset.open = isOpen ? 'true' : 'false';
  }

  function onMessage(event) {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== assistantOrigin) return;

    var data = event.data;
    if (!data || data.type !== 'demo-line-assistant:resize' || typeof data.open !== 'boolean') return;
    applySize(data.open);
  }

  function mount() {
    if (document.getElementById(IFRAME_ID)) return;

    iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = new URL('/widget', assistantOrigin).href;
    iframe.title = '示范线AI智能助手';
    iframe.setAttribute('aria-label', '示范线AI智能助手');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.position = 'fixed';
    iframe.style.right = '16px';
    iframe.style.bottom = '16px';
    iframe.style.display = 'block';
    iframe.style.border = '0';
    iframe.style.padding = '0';
    iframe.style.margin = '0';
    iframe.style.background = 'transparent';
    iframe.style.overflow = 'hidden';
    iframe.style.zIndex = '2147483000';
    iframe.style.boxShadow = 'none';
    iframe.style.colorScheme = 'normal';
    iframe.style.transition = 'width 180ms ease, height 180ms ease';

    applySize(false);
    document.body.appendChild(iframe);
    window.addEventListener('message', onMessage, false);
    window.addEventListener('resize', function () {
      applySize(iframe && iframe.dataset.open === 'true');
    }, { passive: true });
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
}());
