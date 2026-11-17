let checking = false;
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('relay', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('relay', { periodInMinutes: 1 }));
function targetsChat(value, chatId) {
  try { const url = new URL(value); return url.origin === 'https://chatgpt.com' && url.pathname === `/c/${chatId}`; } catch { return false; }
}
async function relayRequest(c, route, options = {}) {
  const latest = (await chrome.storage.local.get('relayConfig')).relayConfig;
  if (!latest?.enabled || latest.version !== 2 || latest.token !== c.token || latest.chatId !== c.chatId || !(Date.parse(latest.expiresAt) > Date.now())) throw new Error('通知授权已关闭或到期');
  const r = await fetch(`http://127.0.0.1:17321/${route}`, { ...options, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('本机中转未就绪或授权已撤销'); return r.json();
}
async function check() {
  if (checking) return; checking = true;
  try {
    const { relayConfig: c } = await chrome.storage.local.get('relayConfig');
    if (!c?.enabled || c.version !== 2 || !(Date.parse(c.expiresAt) > Date.now())) return;
    const next = await relayRequest(c, 'next'), { packet } = next;
    if (!packet) { await chrome.storage.local.set({ relayStatus: '暂无新的授权结果' }); return; }
    if (packet.chatId !== c.chatId) throw new Error('目标聊天不符');
    const tabs = (await chrome.tabs.query({ url: `https://chatgpt.com/c/${c.chatId}*` })).filter(tab => targetsChat(tab.url, c.chatId));
    if (tabs.length !== 1) throw new Error('请保留且只打开一个目标聊天标签页');
    let result, attempt = next.attempt;
    if (next.delivery === 'uncertain') {
      // Recovery can inspect the user bubble, but it must not type or click again.
      result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'relay-inspect', packet });
    } else {
      const prepared = await chrome.tabs.sendMessage(tabs[0].id, { type: 'relay-prepare', packet });
      if (!prepared?.ready && !prepared?.delivered) { await chrome.storage.local.set({ relayStatus: prepared?.reason || '等待聊天就绪' }); return; }
      const claimed = await relayRequest(c, 'claim', { method: 'POST', body: JSON.stringify({ id: packet.id }) });
      if (claimed.packet?.id !== packet.id || claimed.packet?.chatId !== c.chatId || !/^[a-f0-9]{64}$/.test(claimed.attempt || '')) throw new Error('本机发送凭证不符');
      attempt = claimed.attempt;
      result = prepared.delivered ? prepared : await chrome.tabs.sendMessage(tabs[0].id, { type: 'relay-result', packet: claimed.packet, attempt });
    }
    if (result?.delivered) await relayRequest(c, 'ack', { method: 'POST', body: JSON.stringify({ id: packet.id, attempt }) });
    await chrome.storage.local.set({ relayStatus: result?.delivered ? '已确认送达' : (result?.reason || '等待聊天空闲') });
  } catch (e) { await chrome.storage.local.set({ relayStatus: e.message || '中转失败，未确认送达' }); }
  finally { checking = false; }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'relay') check(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'check') { check(); return; }
  if (message.type !== 'permit-send') return;
  (async () => {
    const c = (await chrome.storage.local.get('relayConfig')).relayConfig;
    if (!c || sender.frameId !== 0 || !targetsChat(sender.tab?.url, c.chatId)) return { allowed: false };
    return relayRequest(c, 'permit', { method: 'POST', body: JSON.stringify({ id: message.id, attempt: message.attempt }) });
  })().then(respond, () => respond({ allowed: false }));
  return true;
});
