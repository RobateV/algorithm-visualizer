let delivering = false;
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!['relay-result', 'relay-prepare', 'relay-inspect'].includes(request.type) || sender.id !== chrome.runtime.id) return;
  (async () => {
    const p = request.packet;
    const { relayConfig: config } = await chrome.storage.local.get('relayConfig');
    const marker = typeof p?.marker === 'string' && p.marker.match(/^\[LOCAL-DSH-NOTIFY:([A-Za-z0-9._-]{1,64}):([0-9a-f]{40}|failed)\]$/);
    if (!config?.enabled || config.version !== 2 || !(Date.parse(config.expiresAt) > Date.now()) || location.origin !== 'https://chatgpt.com' || location.pathname !== `/c/${config.chatId}` || p?.chatId !== config.chatId || typeof p.message !== 'string' || p.message.length > 4000 || !p.message.startsWith(p.marker) || !marker || p.id !== `${marker[1]}:${marker[2]}`) return { delivered: false, reason: '目标、授权或消息格式不符' };
    const visibleMessage = () => [...document.querySelectorAll('[data-message-author-role="user"]')].some((node) => node.textContent.includes(p.marker));
    const key = `local-dsh-attempt:${p.id}`;
    if (visibleMessage()) { sessionStorage.setItem(key, 'confirmed'); return { delivered: true }; }
    if (request.type === 'relay-inspect') return { delivered: false, reason: '上次送达状态不明，仅核对页面，不会自动重发' };
    if (sessionStorage.getItem(key)) return { delivered: false, reason: '上次送达状态不明，停止自动重发，请核实原聊天' };
    if (delivering || document.querySelector('[data-testid="stop-button"]')) return { delivered: false, reason: '聊天正在回复，稍后重试' };
    const editor = document.querySelector('#prompt-textarea[contenteditable="true"]');
    const button = document.querySelector('[data-testid="send-button"]');
    if (!editor || !button) return { delivered: false, reason: '登录、页面加载或输入界面需要人工检查' };
    if (editor.textContent.trim()) return { delivered: false, reason: '输入框已有草稿，未覆盖' };
    if (button.disabled) return { delivered: false, reason: '发送按钮不可用，稍后重试' };
    if (request.type === 'relay-prepare') return { ready: true };
    if (!/^[a-f0-9]{64}$/.test(request.attempt || '')) return { delivered: false, reason: '缺少本机一次性发送凭证' };
    delivering = true;
    try {
      sessionStorage.setItem(key, 'attempted');
      editor.focus(); document.execCommand('insertText', false, p.message);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (editor.textContent.trim() !== p.message.trim()) return { delivered: false, reason: '文本填入未确认，停止' };
      const permit = await chrome.runtime.sendMessage({ type: 'permit-send', id: p.id, attempt: request.attempt });
      if (permit?.allowed !== true) return { delivered: false, reason: '本地服务已停止、暂停或未再次授权，未点击发送' };
      const latest = (await chrome.storage.local.get('relayConfig')).relayConfig;
      if (!latest?.enabled || latest.token !== config.token || latest.chatId !== config.chatId || !(Date.parse(latest.expiresAt) > Date.now())) return { delivered: false, reason: '发送前通知授权已撤销或到期' };
      if (document.querySelector('#prompt-textarea[contenteditable="true"]') !== editor || editor.textContent.trim() !== p.message.trim() || location.pathname !== `/c/${config.chatId}`) return { delivered: false, reason: '页面或草稿已变化，未点击发送' };
      const send = document.querySelector('[data-testid="send-button"]');
      if (!send || send.disabled || document.querySelector('[data-testid="stop-button"]')) return { delivered: false, reason: '发送按钮不可用，停止' };
      send.click();
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (visibleMessage()) { sessionStorage.setItem(key, 'confirmed'); return { delivered: true }; }
      }
      return { delivered: false, reason: '发送结果未确认，停止自动重发' };
    } finally { delivering = false; }
  })().then(respond, () => respond({ delivered: false, reason: '页面中转异常，未确认送达' }));
  return true;
});
