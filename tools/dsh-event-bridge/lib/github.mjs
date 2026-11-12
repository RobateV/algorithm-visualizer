/**
 * 极简 GitHub REST 客户端：只做接收器需要的两件事——
 * 拉取 issue/PR 评论（支持 ETag 轮询）与读取 PR 当前 HEAD。
 * 无第三方依赖，超时与限流信息都会带回来给上层记录。
 */

export function createGitHubClient({ token, repo, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-event-bridge/0.1'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function request(url, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { ...headers, ...extraHeaders },
        signal: controller.signal
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** @returns {Promise<{notModified:boolean, comments:any[], etag:string, rateLimit:string}>} */
    async listIssueComments({ since = '', etag = '' } = {}) {
      const params = new URLSearchParams({ per_page: '100', sort: 'created', direction: 'desc' });
      if (since) params.set('since', since);
      const headersToSend = etag ? { 'If-None-Match': etag } : {};
      const res = await request(`https://api.github.com/repos/${repo}/issues/comments?${params}`, headersToSend);
      const rateLimit = res.headers.get('x-ratelimit-remaining') || '';
      if (res.status === 304) return { notModified: true, comments: [], etag, rateLimit };
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const comments = await res.json();
      if (!Array.isArray(comments)) throw new Error('GitHub API 返回的评论列表不是数组');
      return { notModified: false, comments, etag: res.headers.get('etag') || etag, rateLimit };
    },

    async getPull(number) {
      const res = await request(`https://api.github.com/repos/${repo}/pulls/${number}`);
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const pr = await res.json();
      return { number: pr.number, state: pr.state, headSha: pr.head && pr.head.sha ? String(pr.head.sha) : '' };
    }
  };
}
