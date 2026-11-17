let delivering = false;
let attachmentActivity = false;
// Disappearing cards or cleared file inputs do not prove an upload has finished.
for (const type of ['change', 'drop', 'paste']) document.addEventListener(type, event => {
  try {
    if (event.target?.type === 'file' || event.dataTransfer?.files?.length ||
        Array.from(event.dataTransfer?.types || []).includes('Files') ||
        Array.from(event.clipboardData?.items || []).some(item => item.kind === 'file')) attachmentActivity = true;
  } catch { attachmentActivity = true; }
}, true);
function attachmentFreeComposer(editor) {
  // Fail closed on unsupported composer structures; new layouts need verified fixtures.
  try {
    if (attachmentActivity) return null;
    const form = editor.closest('form');
    if (!form || !form.elements || !form.contains(editor) || form.querySelectorAll('#prompt-textarea').length !== 1) return null;
    for (const input of document.querySelectorAll('input[type="file"]')) {
      if (!input.files || input.files.length !== 0 || input.value) return null;
    }
    const tags = new Set(['FORM', 'DIV', 'SPAN', 'P', 'BR', 'BUTTON', 'INPUT', 'LABEL', 'SVG', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON', 'G', 'DEFS', 'CLIPPATH', 'TITLE', 'USE']);
    const testIds = new Set(['prompt-textarea', 'send-button', 'stop-button', 'composer-submit-button', 'composer-plus-btn', 'composer-speech-button', 'composer-voice-button']);
    for (const node of [form, ...form.querySelectorAll('*'), ...form.elements]) {
      if (node.shadowRoot) return null;
      if (!tags.has(node.tagName.toUpperCase())) return null;
      if (node.getAttribute('aria-busy') === 'true' || ['progressbar', 'status'].includes(node.getAttribute('role'))) return null;
      if (node.tagName.toUpperCase() === 'INPUT') {
        if (node.type !== 'file' || !node.files || node.files.length !== 0 || node.value) return null;
      }
      for (const attr of node.attributes) {
        if (attr.name === 'data-testid' && !testIds.has(attr.value)) return null;
        if (attr.name.startsWith('data-') && !['data-testid', 'data-placeholder'].includes(attr.name)) return null;
        if (['title', 'aria-label', 'alt'].includes(attr.name) && /\.[a-z0-9]{1,10}(?:\s|$)/i.test(attr.value)) return null;
        if (node.tagName.toUpperCase() !== 'INPUT' && /attachment|upload|thumbnail|file-preview|\.pdf\b|\.(?:png|jpe?g|gif|webp)\b/i.test(attr.value)) return null;
      }
      for (const child of node.childNodes) {
        if (child.nodeType !== 3 || !child.textContent.trim() || editor.contains(node)) continue;
        const control = node.closest('button, label, svg');
        if (!control || !/^(?:发送|停止|添加|工具|搜索|思考|语音|听写|高|中|低|Send|Stop|Add|Tools|Search|Think|Voice|Dictate)$/i.test(child.textContent.trim())) return null;
      }
    }
    return form;
  } catch { return null; }
}
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
    if (!editor) return { delivered: false, reason: '未识别到可编辑输入框，页面结构需检查' };
    if (editor.textContent.trim()) return { delivered: false, reason: '输入框已有草稿，未覆盖' };
    const composer = attachmentFreeComposer(editor);
    if (!composer) return { delivered: false, reason: '附件、上传或 composer 状态不明确，未修改或发送' };
    // Empty composers may show voice controls; sending is checked after insertion.
    if (request.type === 'relay-prepare') return { ready: true };
    if (!/^[a-f0-9]{64}$/.test(request.attempt || '')) return { delivered: false, reason: '缺少本机一次性发送凭证' };
    delivering = true;
    try {
      sessionStorage.setItem(key, 'attempted');
      editor.focus(); document.execCommand('insertText', false, p.message);
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (editor.textContent.trim() !== p.message.trim()) return { delivered: false, reason: '文本填入未确认，停止' };
      if (attachmentFreeComposer(editor) !== composer) return { delivered: false, reason: '附件或上传状态已变化，未发送' };
      const permit = await chrome.runtime.sendMessage({ type: 'permit-send', id: p.id, attempt: request.attempt });
      if (permit?.allowed !== true) return { delivered: false, reason: '本地服务已停止、暂停或未再次授权，未点击发送' };
      const latest = (await chrome.storage.local.get('relayConfig')).relayConfig;
      if (!latest?.enabled || latest.token !== config.token || latest.chatId !== config.chatId || !(Date.parse(latest.expiresAt) > Date.now())) return { delivered: false, reason: '发送前通知授权已撤销或到期' };
      if (document.querySelector('#prompt-textarea[contenteditable="true"]') !== editor || editor.textContent.trim() !== p.message.trim() || location.pathname !== `/c/${config.chatId}`) return { delivered: false, reason: '页面或草稿已变化，未点击发送' };
      const send = document.querySelector('[data-testid="send-button"]');
      if (attachmentFreeComposer(editor) !== composer) return { delivered: false, reason: '发送前附件状态不安全，未发送' };
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
