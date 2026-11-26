(() => {
  let installPrompt;
  let installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const registration = window.isSecureContext && 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    installPrompt = null;
    document.querySelector('#device-install')?.setAttribute('hidden', '');
    document.querySelector('#install-help')?.setAttribute('hidden', '');
  });

  document.addEventListener('DOMContentLoaded', async () => {
    const card = document.querySelector('#device-card');
    if (!card) return;
    const menu = document.querySelector('#device-menu');
    const pushButton = document.querySelector('#device-push');
    const installButton = document.querySelector('#device-install');
    const help = document.querySelector('#install-help');
    const status = document.querySelector('#device-status');
    const preferenceKey = 'vieira-push:' + card.dataset.user;
    let reg;
    let supported = window.isSecureContext && 'serviceWorker' in navigator && 'Notification' in window &&
      ('PushManager' in window || 'pushManager' in (window.ServiceWorkerRegistration?.prototype || {}));
    const iosInstall = appleMobile && !installed;
    let publicKey;
    let serverKeyBytes;
    let active = false;
    let busy = false;
    let loading = true;
    let loadFailed = false;
    let automatic = true;

    function render() {
      installButton.hidden = installed;
      pushButton.hidden = true;
      pushButton.disabled = busy || loading;
      if (!window.isSecureContext) status.textContent = 'Abra o painel por HTTPS para instalar e receber avisos.';
      else if (iosInstall) status.textContent = 'Adicione o app à Tela de Início e abra pelo ícone para ativar os avisos.';
      else if (!supported) status.textContent = 'Este navegador não oferece notificações push para o painel.';
      else if (loadFailed) status.textContent = 'Não foi possível carregar as preferências. Atualize a página para tentar novamente.';
      else if (loading) {
        pushButton.hidden = false;
        status.textContent = 'Preparando as notificações neste aparelho…';
      }
      else if (!publicKey) status.textContent = 'Peça ao gerente para conectar a conta FLW do painel.';
      else if (Notification.permission === 'denied') status.textContent = 'Para receber avisos, permita as notificações nas configurações deste app ou site.';
      else {
        status.textContent = active ? 'Notificações de novas mensagens ativadas neste aparelho.' :
          'Receba um aviso quando um cliente escrever, mesmo com o painel fechado.';
        pushButton.textContent = active ? 'Desativar notificações' : 'Ativar notificações';
        pushButton.hidden = false;
      }
    }
    function close() {
      automatic = false;
      card.hidden = true;
    }
    menu.addEventListener('click', () => {
      automatic = false;
      document.querySelector('#menu-close')?.click();
      card.hidden = false;
      render();
      document.querySelector('#device-close').focus();
    });
    document.querySelector('#device-close').addEventListener('click', close);
    installButton.addEventListener('click', async () => {
      if (installPrompt) {
        const prompt = installPrompt;
        installPrompt = null;
        await prompt.prompt();
        await prompt.userChoice;
      } else {
        help.textContent = appleMobile ? 'No Safari, toque em Compartilhar → Adicionar à Tela de Início → Adicionar.' :
          'Abra o menu do navegador e escolha Instalar aplicativo ou Adicionar à tela inicial.';
        help.hidden = false;
      }
    });
    pushButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      pushButton.disabled = true;
      let errorMessage;
      try {
        if (active) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await api('/push', { method: 'DELETE', body: { endpoint: sub.endpoint } });
            await sub.unsubscribe();
          }
          active = false;
          localStorage.removeItem(preferenceKey);
        } else {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            let sub = await reg.pushManager.getSubscription();
            if (sub && !sameServerKey(sub)) {
              await sub.unsubscribe();
              sub = null;
            }
            sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKeyBytes });
            await api('/push', { method: 'PUT', body: sub.toJSON() });
            active = true;
            localStorage.setItem(preferenceKey, 'on');
            if (automatic) {
              card.hidden = true;
              toast('Notificações ativadas neste aparelho.');
            }
          }
        }
      } catch {
        errorMessage = 'Não foi possível atualizar os avisos. Confira a conexão e tente novamente.';
      } finally {
        busy = false;
        render();
        if (errorMessage) status.textContent = errorMessage;
      }
    });
    function sameServerKey(sub) {
      const bytes = new Uint8Array(sub.options.applicationServerKey);
      return bytes.length === serverKeyBytes.length && bytes.every((byte, i) => byte === serverKeyBytes[i]);
    }
    function offerOnEntry() {
      if (!automatic) return;
      const offerInstall = !installed && window.isSecureContext && (iosInstall || installPrompt || matchMedia('(pointer: coarse)').matches);
      const configured = document.body.dataset.configured === 'true';
      const offerPush = supported && configured && Notification.permission !== 'denied';
      const previouslyEnabled = loading && supported && Notification.permission === 'granted' && localStorage.getItem(preferenceKey) === 'on';
      card.hidden = active || previouslyEnabled || !(offerInstall || offerPush);
    }
    render();
    offerOnEntry();
    try {
      reg = await registration;
      supported = Boolean(reg && 'pushManager' in reg && 'Notification' in window);
      if (supported && !iosInstall) {
        ({ publicKey } = await api('/push'));
        if (publicKey) serverKeyBytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        if (publicKey && Notification.permission === 'granted' && localStorage.getItem(preferenceKey) === 'on') {
          const sub = await reg.pushManager.getSubscription();
          if (sub && sameServerKey(sub)) {
            await api('/push', { method: 'PUT', body: sub.toJSON() });
            active = true;
          }
        }
      }
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
      render();
      offerOnEntry();
    }
  });
})();
