/**
 * 资料源客户端。
 *
 * 资料源把每一版资料按“发布序号”保留下来，而且应答可能滞后于预检/登记动作：
 * 门户已经收到登记但客户端只拿到 503/409 时，必须回到 /receipt 按业务标识和
 * 有效范围查明单据，而不是直接重提票据。所有读取都带缓存失效与来源失败重试。
 */

const DEFAULT_TIMEOUT = 5000

export class SourceError extends Error {
  constructor(message, { status = 0, body = null, path = '' } = {}) {
    super(message)
    this.name = 'SourceError'
    this.status = status
    this.body = body
    this.path = path
  }
}

/** 门户明确给出“资料不合格/冲突”时抛出，调用方据此回到必填字段。 */
export class PortalRejection extends SourceError {
  constructor(message, options) {
    super(message, options)
    this.name = 'PortalRejection'
  }
}

export function makeSourceClient(base, { fetchImpl = fetch, timeout = DEFAULT_TIMEOUT } = {}) {
  const root = new URL(base)
  const cache = new Map()

  async function raw(path, { method = 'GET', body, headers } = {}) {
    const url = new URL(path, root)
    url.searchParams.sort()
    const key = method + ' ' + url.pathname + url.search
    const response = await fetchImpl(url, {
      method,
      signal: AbortSignal.timeout(timeout),
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* 纯文本应答 */ }
    return { status: response.status, body: parsed, key, url }
  }

  function remember(key, value) {
    cache.set(key, value)
  }

  async function get(path, { fresh = false } = {}) {
    const url = new URL(path, root)
    url.searchParams.sort()
    const key = 'GET ' + url.pathname + url.search
    if (!fresh && cache.has(key)) return cache.get(key)
    const response = await raw(path)
    if (response.status !== 200) {
      throw new SourceError(`资料源拒绝读取 ${path}`, { status: response.status, body: response.body, path })
    }
    remember(key, response.body)
    return response.body
  }

  async function post(path, body) {
    const response = await raw(path, { method: 'POST', body })
    return response
  }

  return {
    origin: root,
    cache,
    invalidate(path) {
      if (path === undefined) return cache.clear()
      const url = new URL(path, root)
      url.searchParams.sort()
      for (const key of cache.keys()) {
        if (key.endsWith(url.pathname + url.search)) cache.delete(key)
      }
    },
    handover: () => get('/handover', { fresh: true }),
    service: () => get('/service', { fresh: true }),
    orders: () => get('/orders', { fresh: true }),
    capacity: () => get('/visit-capacity', { fresh: true }),
    receipt: business => get('/receipt?business=' + encodeURIComponent(business), { fresh: true }),
    precheck: body => post('/precheck', body),
    register: body => post('/registration', body),
    raw,
  }
}
