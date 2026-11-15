let checking = false;
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('relay', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('relay', { periodInMinutes: 1 }));
async function check() {
  if (checking) return; checking = true;
  try {
    const { relayConfig: c } = await chrome.storage.local.get('relayConfig');
    if (!c?.enabled) return;
    const request = async (route, options = {}) => {
      const r = await fetch(`http://127.0.0.1:17321/${route}`, { ...options, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('本机中转未就绪'); return r.json();
    };
    const { packet } = await request('next'); if (!packet) return;
    if (packet.chatId !== c.chatId) throw new Error('目标聊天不符');
    const tabs = await chrome.tabs.query({ url: `https://chatgpt.com/c/${c.chatId}*` });
    if (tabs.length !== 1) throw new Error('请保留且只打开一个目标聊天标签页');
    const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'relay-result', packet });
    if (result?.delivered) await request('ack', { method: 'POST', body: JSON.stringify({ id: packet.id }) });
    await chrome.storage.local.set({ relayStatus: result?.delivered ? '已确认送达' : (result?.reason || '等待聊天空闲') });
  } catch (e) { await chrome.storage.local.set({ relayStatus: e.message || '中转失败，未确认送达' }); }
  finally { checking = false; }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'relay') check(); });
chrome.runtime.onMessage.addListener((message) => { if (message.type === 'check') check(); });
