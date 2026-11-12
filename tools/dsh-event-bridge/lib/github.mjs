/**
 * 极简 GitHub REST 客户端：只做接收器需要的两件事——
 * 拉取 issue/PR 评论（支持 since 水位 + Link 分页）与读取 PR 当前 HEAD。
 *
 * 不使用 ETag：本接收器的正确性依赖"since 水位 + 分页 + 评论 id 去重"，
 * 与其声称启用了 If-None-Match 却无法与分页共存，不如明确不使用。
 */

/** 从 Link 头里取出 rel="next" 的页码；没有则返回 null */
export function parseNextPage(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(',')) {
    if (!/rel="next"/.test(part)) continue;
    const m = part.match(/[?&]page=(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

export function createGitHubClient({ token, repo, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-event-bridge/0.2'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * 拉取一页评论。
     * @param {{since?:string, page?:number, perPage?:number}} options
     * @returns {Promise<{comments:any[], nextPage:number|null, rateLimit:string}>}
     */
    async listIssueComments({ since = '', page = 1, perPage = 100 } = {}) {
      const params = new URLSearchParams({
        per_page: String(perPage),
        sort: 'created',
        direction: 'asc',
        page: String(page)
      });
      // since 按 updated_at 过滤：新评论与"被编辑过的旧评论"都会返回，
      // 重叠部分由评论 id 去重兜底。
      if (since) params.set('since', since);

      const res = await request(`https://api.github.com/repos/${repo}/issues/comments?${params}`);
      const rateLimit = res.headers.get('x-ratelimit-remaining') || '';
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const comments = await res.json();
      if (!Array.isArray(comments)) throw new Error('GitHub API 返回的评论列表不是数组');
      return {
        comments,
        nextPage: parseNextPage(res.headers.get('link')),
        rateLimit
      };
    },

    async getPull(number) {
      const res = await request(`https://api.github.com/repos/${repo}/pulls/${number}`);
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const pr = await res.json();
      return { number: pr.number, state: pr.state, headSha: pr.head && pr.head.sha ? String(pr.head.sha) : '' };
    },

    /** 读取单条评论；已删除返回 null（调用方据此拒绝任务） */
    async getComment(id) {
      const res = await request(`https://api.github.com/repos/${repo}/issues/comments/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const c = await res.json();
      return {
        id: c.id,
        body: c.body || '',
        user: { login: c.user && c.user.login },
        issueUrl: c.issue_url || '',
        createdAt: c.created_at || '',
        updatedAt: c.updated_at || ''
      };
    }
  };
}
