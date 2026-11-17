const enabled = document.querySelector('#enabled'), status = document.querySelector('#status');
async function refresh() {
  const s = await chrome.storage.local.get(['relayConfig', 'relayStatus']), c = s.relayConfig;
  enabled.checked = !!c?.enabled; status.textContent = s.relayStatus || '已关闭或尚未配置';
  const target = document.querySelector('#target'); target.hidden = !c;
  if (c) { target.href = `https://chatgpt.com/c/${c.chatId}`; document.querySelector('#limits').textContent = `本机授权至 ${c.expiresAt ? new Date(c.expiresAt).toLocaleString() : '尚未激活'}，最多 ${c.maxNotifications} 次通知。`; }
}
document.querySelector('#file').onchange = async (e) => {
  try {
    const c = JSON.parse(await e.target.files[0].text());
    if (c.version !== 2 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.chatId) || c.port !== 17321 || !/^[0-9a-f]{64}$/.test(c.token) || !Number.isInteger(c.maxNotifications) || c.maxNotifications < 1 || c.maxNotifications > 10) throw new Error('配置不符');
    await chrome.storage.local.set({ relayConfig: { version: 2, chatId: c.chatId, token: c.token, expiresAt: c.expiresAt, maxNotifications: c.maxNotifications, enabled: false }, relayStatus: '配置已导入，尚未授权发送' }); await refresh();
  } catch { status.textContent = '配置读取失败，未启用'; }
};
enabled.onchange = async () => { const s = await chrome.storage.local.get('relayConfig'); if (!s.relayConfig || (enabled.checked && !(Date.parse(s.relayConfig.expiresAt) > Date.now()))) { enabled.checked = false; status.textContent = '请先导入本机已激活且未到期的配置'; return; } await chrome.storage.local.set({ relayConfig: { ...s.relayConfig, enabled: enabled.checked }, relayStatus: enabled.checked ? '已授权，每分钟检查；状态不明不重发' : '已关闭' }); await refresh(); };
document.querySelector('#check').onclick = () => chrome.runtime.sendMessage({ type: 'check' });
refresh();
