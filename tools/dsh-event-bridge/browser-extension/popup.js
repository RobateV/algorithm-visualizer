const enabled = document.querySelector('#enabled'), status = document.querySelector('#status');
async function refresh() { const s = await chrome.storage.local.get(['relayConfig', 'relayStatus']); enabled.checked = !!s.relayConfig?.enabled; status.textContent = s.relayStatus || '已关闭或尚未配置'; }
document.querySelector('#file').onchange = async (e) => {
  try {
    const c = JSON.parse(await e.target.files[0].text());
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.chatId) || c.port !== 17321 || !/^[0-9a-f]{64}$/.test(c.token)) throw new Error('配置不符');
    await chrome.storage.local.set({ relayConfig: { chatId: c.chatId, token: c.token, enabled: false }, relayStatus: '配置已导入，尚未授权发送' }); await refresh();
  } catch { status.textContent = '配置读取失败，未启用'; }
};
enabled.onchange = async () => { const s = await chrome.storage.local.get('relayConfig'); if (!s.relayConfig) { enabled.checked = false; status.textContent = '请先导入本机配置'; return; } await chrome.storage.local.set({ relayConfig: { ...s.relayConfig, enabled: enabled.checked }, relayStatus: enabled.checked ? '已授权，每分钟检查' : '已关闭' }); await refresh(); };
document.querySelector('#check').onclick = () => chrome.runtime.sendMessage({ type: 'check' });
refresh();
