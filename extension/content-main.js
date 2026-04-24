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

  function initAssemblyCreationGuard() {
    waitForEl('ul#document-tabs-create-ul', (ul) => {
      new MutationObserver(() => {
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
      }).observe(ul, { attributes: true, attributeFilter: ['style', 'class'] });
    });
  }

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
      return _fetch.apply(this, args);
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

  initAssemblyCreationGuard();
  initAssemblyFetchGuard();
})();
