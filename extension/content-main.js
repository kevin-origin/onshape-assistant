// content-main.js — runs in MAIN world to observe Angular-managed DOM changes

(function () {
  function waitForEl(selector, callback) {
    const el = document.querySelector(selector);
    if (el) { callback(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); callback(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Disables the "Create Assembly" button in the new-tab dropdown when the document
   * already has an assembly. Reads `document.documentElement.dataset.oxtAssemblyCount`
   * (written by content.js) and re-applies the guard whenever that attribute or the
   * dropdown visibility changes.
   */
  function initAssemblyCreationGuard() {
    waitForEl('ul#document-tabs-create-ul', (ul) => {
      function applyAssemblyGuard() {
        if (ul.offsetHeight === 0) return;

        const hasAssembly = parseInt(document.documentElement.dataset.oxtAssemblyCount || '0') > 0;

        let btn = ul.querySelector('a#create-assembly-button');
        if (!btn) {
          for (const a of ul.querySelectorAll('a')) {
            const text = a.textContent.trim().toLowerCase();
            if (text === 'assembly' || text === 'create assembly' || text === 'new assembly') {
              btn = a; break;
            }
          }
        }
        if (!btn) return;

        if (hasAssembly) {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.4';
          btn.style.cursor = 'not-allowed';
          btn.title = 'Document already has an assembly';
          if (!btn._assemblyGuardListener) {
            btn._assemblyGuardListener = (e) => { e.preventDefault(); e.stopPropagation(); };
            btn.addEventListener('click', btn._assemblyGuardListener, true);
          }
        } else {
          btn.style.pointerEvents = '';
          btn.style.opacity = '';
          btn.style.cursor = '';
          btn.title = '';
          if (btn._assemblyGuardListener) {
            btn.removeEventListener('click', btn._assemblyGuardListener, true);
            btn._assemblyGuardListener = null;
          }
        }
      }

      // Fire when dropdown becomes visible (style/class toggle)
      new MutationObserver(applyAssemblyGuard)
        .observe(ul, { attributes: true, attributeFilter: ['style', 'class'] });

      // Also re-check when oxtAssemblyCount is updated by content.js mid-open
      new MutationObserver(applyAssemblyGuard)
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-oxt-assembly-count'] });
    });
  }

  /**
   * Backstop guard: patches window.fetch to intercept POST /api/vN/assemblies requests.
   * Returns a synthetic 400 response and shows a toast if oxtAssemblyCount > 0.
   * Catches cases where the DOM button guard is bypassed (e.g., keyboard shortcuts, external callers).
   *
   * Also detects compliance events (version/workspace/translation POSTs) and notifies
   * the extension service worker via window.postMessage → content.js relay (MAIN→ISOLATED).
   */
  function initAssemblyFetchGuard() {
    const _fetch = window.fetch;
    window.fetch = async function (...args) {
      const [url, opts] = args;
      if (
        typeof url === 'string' &&
        /\/api\/v\d+\/assemblies($|\?)/.test(url) &&
        opts?.method === 'POST'
      ) {
        const hasAssembly = parseInt(document.documentElement.dataset.oxtAssemblyCount || '0') > 0;
        if (hasAssembly) {
          showAssemblyBlockedToast();
          return new Response(
            JSON.stringify({ message: 'Document already has an assembly' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      const promise = _fetch.apply(this, args);

      // Compliance event detection — fire-and-forget after fetch resolves.
      // Uses window.postMessage (MAIN→ISOLATED) since chrome.* is unavailable in MAIN world.
      if (typeof url === 'string' && opts?.method === 'POST') {
        promise.then(resp => {
          if (!resp.ok) return;
          let event = null, did = null;

          // createversion: POST .../documents/d/{did}/w/{wid}/workspaces/{wsid}/versions
          const verMatch = url.match(/\/api\/v\d+\/documents\/d\/([a-f0-9]+)\/w\/[a-f0-9]+\/workspaces\/[a-f0-9]+\/versions/);
          if (verMatch) { event = 'onshape.model.lifecycle.createversion'; did = verMatch[1]; }

          // createworkspace: POST .../documents/d/{did}/w/{wid}/workspaces (no further segments)
          if (!event) {
            const wsMatch = url.match(/\/api\/v\d+\/documents\/d\/([a-f0-9]+)\/w\/[a-f0-9]+\/workspaces($|\?)/);
            if (wsMatch) { event = 'onshape.model.lifecycle.createworkspace'; did = wsMatch[1]; }
          }

          // translation: POST .../partstudios/d/{did}/... or .../assemblies/d/{did}/... + /translations
          if (!event) {
            const transMatch = url.match(/\/api\/v\d+\/(?:partstudios|assemblies)\/d\/([a-f0-9]+)\/.*\/translations/);
            if (transMatch) { event = 'onshape.model.translation.complete'; did = transMatch[1]; }
          }

          if (event && did) {
            window.postMessage({ type: 'oxt-compliance-event', event, documentId: did }, '*');
          }
        }).catch(() => {});
      }

      return promise;
    };
  }

  function showAssemblyBlockedToast() {
    if (document.getElementById('oxt-assembly-blocked-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'oxt-assembly-blocked-toast';
    toast.textContent = 'This document already has an assembly.';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '32px', left: '50%', transform: 'translateX(-50%)',
      background: '#d32f2f', color: '#fff', padding: '10px 20px',
      borderRadius: '4px', fontSize: '14px', zIndex: '99999',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)', pointerEvents: 'none'
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  /**
   * Watches for Angular context menus inserted into the DOM and applies the context
   * creation guard to each one via applyContextGuard. Observes document.body for
   * added nodes with class `context-menu-root`.
   */
  function initContextCreationGuard() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.classList.contains('context-menu-root')) {
            applyContextGuard(node);
          }
        }
      }
    }).observe(document.body, { childList: true });
  }

  /**
   * Disables "Create new context" in an Angular context menu when other contexts already exist.
   * Blocks click events and grays out the item. Also observes the submenu for late-loaded items.
   * @param {HTMLElement} root - The `.context-menu-root` element just inserted into the DOM.
   */
  function applyContextGuard(root) {
    // Find the "Edit in context" parent LI (class has hyphenated "context-menu-submenu")
    let editInContextLi = null;
    for (const li of root.querySelectorAll('li.context-menu-submenu')) {
      const span = li.querySelector(':scope > span');
      if (span && span.textContent.trim() === 'Edit in context') {
        editInContextLi = li;
        break;
      }
    }
    if (!editInContextLi) return;

    const subUl = editInContextLi.querySelector('ul.contextmenu-list');
    if (!subUl) return;

    function checkAndBlock() {
      const items = subUl.querySelectorAll('li');
      // More than 1 item means existing contexts are present alongside "Create new context"
      if (items.length <= 1) return;

      for (const li of items) {
        const span = li.querySelector('span');
        if (span && span.textContent.trim() === 'Create new context') {
          li.style.pointerEvents = 'none';
          li.style.opacity = '0.4';
          li.style.cursor = 'not-allowed';
          li.classList.add('not-selectable');
          if (!li._contextGuardListener) {
            li._contextGuardListener = (e) => {
              e.preventDefault();
              e.stopPropagation();
              showContextBlockedToast();
            };
            li.addEventListener('click', li._contextGuardListener, true);
          }
        }
      }
    }

    checkAndBlock();
    // Also catch items loaded dynamically on hover
    new MutationObserver(checkAndBlock).observe(subUl, { childList: true });
  }

  function showContextBlockedToast() {
    if (document.getElementById('oxt-context-blocked-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'oxt-context-blocked-toast';
    toast.textContent = 'Part Studio is limited to 1 context.';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '32px', left: '50%', transform: 'translateX(-50%)',
      background: '#d32f2f', color: '#fff', padding: '10px 20px',
      borderRadius: '4px', fontSize: '14px', zIndex: '99999',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)', pointerEvents: 'none'
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  initAssemblyCreationGuard();
  initAssemblyFetchGuard();
  initContextCreationGuard();
})();
