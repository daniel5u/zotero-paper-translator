/** Desktop-owned navigation receiver; no model request or file parsing. */
window.__ModuleLoader__.load({
  id: '@zotero-paper-translator/dsh-bridge',
  factory: () => ({
    inject: ['uiWorkspace', 'layout'],
    apply(ctx) {
      ctx.effect(() => {
        const lifetime = new AbortController();
        const post = async (verb, data) => {
          const response = await fetch('api/zotero-bridge/' + verb, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data), signal: lifetime.signal,
          });
          if (!response.ok) throw new Error('Zotero navigation bridge is unavailable');
          return response.json();
        };
        void (async () => {
          let after = 0, instance;
          while (!lifetime.signal.aborted) {
            try {
              const item = await post('next', { after, instance });
              if (instance !== item.instance) after = 0;
              instance = item.instance;
              if (!item.id) continue;
              let error;
              try { ctx.layout.beginNavigation(); ctx.uiWorkspace.openSession(item.sessionId); }
              catch (reason) { error = reason.message || String(reason); }
              await post('ack', { id: item.id, error });
              after = item.revision;
            } catch (error) {
              if (lifetime.signal.aborted) break;
              console.error('Zotero navigation:', error.message);
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }
        })();
        return () => lifetime.abort();
      }, 'zotero bridge: Desktop navigation');
    },
  }),
});
