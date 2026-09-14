import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient, GitHubError, mapLimit, encodePath } from '../assets/js/github.js';

/* ------------------------------------------------------------------ *
 * 用假的 fetch 拦截请求，验证客户端与 GitHub 的交互次数和参数
 * ------------------------------------------------------------------ */

function installFakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url: String(url), method: init.method || 'GET', body, headers: init.headers || {} };
    calls.push(call);
    const reply = handler(call);
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, {
      status,
      headers: { 'content-type': 'application/json', ...(reply.headers || {}) }
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

const CFG = { token: 't0ken', owner: 'demo-user', repo: 'photos', branch: 'main' };

/* ------------------------------ 工具函数 ------------------------------ */

test('encodePath 逐段编码且保留斜杠', () => {
  assert.equal(encodePath('avatar/abc'), 'avatar/abc');
  assert.equal(encodePath('/avatar/a b.png'), 'avatar/a%20b.png');
  assert.equal(encodePath('目录/文件'), '%E7%9B%AE%E5%BD%95/%E6%96%87%E4%BB%B6');
  assert.equal(encodePath(''), '');
});

test('mapLimit 保持顺序、限制并发、逐项捕获错误', async () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  let running = 0;
  let peak = 0;
  const results = await mapLimit(input, 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (n === 4) throw new Error('boom');
    return n * 2;
  });

  assert.equal(peak, 3, '并发上限必须被遵守');
  assert.deepEqual(
    results.map((r) => (r.ok ? r.value : 'ERR')),
    [2, 4, 6, 'ERR', 10, 12, 14, 16],
    '结果顺序必须与输入一致'
  );
});

test('mapLimit 接受空数组与超限并发数', async () => {
  assert.deepEqual(await mapLimit([], 5, async (x) => x), []);
  const r = await mapLimit([1, 2], 99, async (x) => x + 1);
  assert.deepEqual(r.map((x) => x.value), [2, 3]);
});

/* ------------------------------ listTree ------------------------------ */

test('listTree 只保留前缀下的 blob，并映射出 name/size', async () => {
  const fake = installFakeFetch(() => ({
    body: {
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob', sha: 'r1', size: 10 },
        { path: 'avatar', type: 'tree', sha: 't1' },
        { path: 'avatar/aaa', type: 'blob', sha: 'b1', size: 1024 },
        { path: 'avatar/sub/bbb', type: 'blob', sha: 'b2', size: 2048 },
        { path: 'other/ccc', type: 'blob', sha: 'b3', size: 30 }
      ]
    }
  }));
  try {
    const client = new GitHubClient(CFG);
    const { files, truncated } = await client.listTree('avatar');
    assert.equal(truncated, false);
    assert.deepEqual(files.map((f) => f.path), ['avatar/aaa', 'avatar/sub/bbb']);
    assert.equal(files[0].name, 'aaa');
    assert.equal(files[1].name, 'bbb');
    assert.equal(files[0].size, 1024);
    assert.match(fake.calls[0].url, /\/repos\/demo-user\/photos\/git\/trees\/main\?recursive=1$/);
    assert.equal(fake.calls[0].headers.Authorization, 'Bearer t0ken');
  } finally {
    fake.restore();
  }
});

test('listTree 前缀收尾斜杠被容忍，空仓库树不报错', async () => {
  const fake = installFakeFetch(() => ({ body: { tree: [] } }));
  try {
    const client = new GitHubClient(CFG);
    assert.deepEqual((await client.listTree('/avatar/')).files, []);
  } finally {
    fake.restore();
  }
});

/* ------------------------------ putFile ------------------------------ */

test('putFile：新文件一次 PUT 成功', async () => {
  const fake = installFakeFetch(() => ({ status: 201, body: { commit: { sha: 'c1' }, content: { sha: 'f1' } } }));
  try {
    const client = new GitHubClient(CFG);
    const res = await client.putFile('avatar/aaa', 'QUJD', { message: 'add aaa' });
    assert.deepEqual(
      { created: res.created, updated: res.updated, skipped: res.skipped, commit: res.commit },
      { created: true, updated: false, skipped: false, commit: 'c1' }
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, 'PUT');
    assert.equal(fake.calls[0].body.content, 'QUJD');
    assert.equal(fake.calls[0].body.branch, 'main');
    assert.equal(fake.calls[0].body.sha, undefined, '新文件不应带 sha');
  } finally {
    fake.restore();
  }
});

test('putFile：文件已存在且未开启覆盖 → 跳过，且不会再发 PUT', async () => {
  let putCount = 0;
  const fake = installFakeFetch((call) => {
    if (call.method === 'PUT') {
      putCount++;
      return { status: 422, body: { message: "Invalid request.\n\n\"sha\" wasn't supplied." } };
    }
    return { body: { path: 'avatar/aaa', sha: 'old-sha', size: 5 } };
  });
  try {
    const client = new GitHubClient(CFG);
    const res = await client.putFile('avatar/aaa', 'QUJD', { overwrite: false });
    assert.equal(res.skipped, true);
    assert.equal(res.sha, 'old-sha');
    assert.equal(putCount, 1, '跳过时不应重发 PUT');
  } finally {
    fake.restore();
  }
});

test('putFile：文件已存在且开启覆盖 → 带旧 sha 重发 PUT', async () => {
  const fake = installFakeFetch((call) => {
    if (call.method === 'PUT' && !call.body.sha) {
      return { status: 422, body: { message: "Invalid request.\n\n\"sha\" wasn't supplied." } };
    }
    if (call.method === 'GET') return { body: { path: 'avatar/aaa', sha: 'old-sha', size: 5 } };
    return { status: 200, body: { commit: { sha: 'c2' }, content: { sha: 'new-sha' } } };
  });
  try {
    const client = new GitHubClient(CFG);
    const res = await client.putFile('avatar/aaa', 'QUJD', { overwrite: true });
    assert.deepEqual({ updated: res.updated, skipped: res.skipped, commit: res.commit }, { updated: true, skipped: false, commit: 'c2' });
    const puts = fake.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.equal(puts[1].body.sha, 'old-sha', '重发必须带旧 sha');
  } finally {
    fake.restore();
  }
});

test('putFile：非 sha 原因的 422 必须原样抛出，不能被当成「文件已存在」', async () => {
  const fake = installFakeFetch(() => ({ status: 422, body: { message: 'Content is too large' } }));
  try {
    const client = new GitHubClient(CFG);
    await assert.rejects(() => client.putFile('avatar/aaa', 'QUJD'), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 422);
      assert.match(error.message, /Content is too large/);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  } finally {
    fake.restore();
  }
});

test('putFile：已知 sha 时一次 PUT 直接覆盖', async () => {
  const fake = installFakeFetch(() => ({ status: 200, body: { commit: { sha: 'c3' }, content: { sha: 'new' } } }));
  try {
    const client = new GitHubClient(CFG);
    const res = await client.putFile('avatar/aaa', 'QUJD', { sha: 'known-sha' });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].body.sha, 'known-sha');
    assert.equal(res.updated, true);
    assert.equal(res.created, false);
  } finally {
    fake.restore();
  }
});

test('putFile 可以带上自定义提交者信息', async () => {
  const fake = installFakeFetch(() => ({ status: 201, body: { commit: { sha: 'c' }, content: { sha: 'f' } } }));
  try {
    const client = new GitHubClient(CFG);
    await client.putFile('avatar/a', 'QQ==', { author: { name: 'Bot', email: 'bot@example.com' } });
    assert.deepEqual(fake.calls[0].body.author, { name: 'Bot', email: 'bot@example.com' });
    assert.deepEqual(fake.calls[0].body.committer, { name: 'Bot', email: 'bot@example.com' });
  } finally {
    fake.restore();
  }
});

/* --------------------------- 删除 / 重命名 --------------------------- */

test('deleteFile 走 DELETE 并带上 sha', async () => {
  const fake = installFakeFetch(() => ({ body: { commit: { sha: 'dc' } } }));
  try {
    const client = new GitHubClient(CFG);
    const res = await client.deleteFile('avatar/aaa', 'f1');
    assert.equal(fake.calls[0].method, 'DELETE');
    assert.deepEqual(fake.calls[0].body, { message: 'avatar: delete avatar/aaa', sha: 'f1', branch: 'main' });
    assert.equal(res.commit, 'dc');
  } finally {
    fake.restore();
  }
});

test('moveFile = 读旧内容 → 写新路径 → 删旧路径', async () => {
  const fake = installFakeFetch((call) => {
    if (call.url.includes('/git/blobs/')) return { body: { content: 'QUJD\nRA==', encoding: 'base64' } };
    if (call.method === 'PUT') return { status: 201, body: { commit: { sha: 'pc' }, content: { sha: 'ns' } } };
    return { body: { commit: { sha: 'dc' } } };
  });
  try {
    const client = new GitHubClient(CFG);
    await client.moveFile('avatar/old', 'avatar/new', 'old-sha');
    assert.deepEqual(
      fake.calls.map((c) => c.method),
      ['GET', 'PUT', 'DELETE']
    );
    assert.equal(fake.calls[1].body.content, 'QUJDRA==', 'blob 的折行必须被清掉');
    assert.equal(fake.calls[2].body.sha, 'old-sha');
  } finally {
    fake.restore();
  }
});

/* ------------------------------ 错误提示 ------------------------------ */

test('错误被翻译成可操作的中文提示', async () => {
  const cases = [
    [401, { message: 'Bad credentials' }, /令牌无效或已过期/],
    [403, { message: 'API rate limit exceeded' }, /速率限制/],
    [403, { message: 'Resource not accessible by personal access token' }, /Contents: Read and write/],
    [404, { message: 'Not Found' }, /仓库名\/分支名拼错/],
    [422, { message: 'Validation Failed' }, /请求被拒绝（422）：Validation Failed/],
    [500, { message: 'oops' }, /服务器错误/]
  ];
  for (const [status, body, pattern] of cases) {
    const fake = installFakeFetch(() => ({ status, body }));
    try {
      const client = new GitHubClient(CFG);
      await assert.rejects(() => client.getRepo(), (error) => {
        assert.match(error.message, pattern, `状态码 ${status} 的提示不符合预期：${error.message}`);
        return true;
      });
    } finally {
      fake.restore();
    }
  }
});

test('getFileMeta 在 404 时返回 null 而不是抛错；tryGetRepo 同理', async () => {
  const fake = installFakeFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
  try {
    const client = new GitHubClient(CFG);
    assert.equal(await client.getFileMeta('avatar/x'), null);
    assert.equal(await client.tryGetRepo(), null);
  } finally {
    fake.restore();
  }
});

test('空仓库的 409 被翻译成「仓库是空的」而不是含糊的冲突提示', async () => {
  const fake = installFakeFetch(() => ({ status: 409, body: { message: 'Git Repository is empty.' } }));
  try {
    const client = new GitHubClient(CFG);
    await assert.rejects(() => client.listTree('avatar'), (error) => {
      assert.match(error.message, /仓库是空的/);
      assert.match(error.message, /初始提交/);
      return true;
    });
  } finally {
    fake.restore();
  }
});

test('速率限制响应头被记录下来', async () => {
  const fake = installFakeFetch(() => ({
    body: { full_name: 'demo-user/photos', private: false },
    headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1700000000' }
  }));
  try {
    const client = new GitHubClient(CFG);
    const repo = await client.getRepo();
    assert.equal(repo.full_name, 'demo-user/photos');
    assert.equal(client.lastRateLimit.remaining, 4999);
    assert.equal(client.lastRateLimit.limit, 5000);
    assert.equal(client.lastRateLimit.reset, 1700000000000);
  } finally {
    fake.restore();
  }
});

test('未配置 token 时不发 Authorization 头（用于公开仓库只读）', async () => {
  const fake = installFakeFetch(() => ({ body: {} }));
  try {
    const client = new GitHubClient({ owner: 'a', repo: 'b' });
    await client.getRepo();
    assert.equal(fake.calls[0].headers.Authorization, undefined);
  } finally {
    fake.restore();
  }
});

test('网络异常被包装成 GitHubError', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const client = new GitHubClient(CFG);
    await assert.rejects(() => client.getRepo(), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.match(error.message, /网络请求失败/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});
