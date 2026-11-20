import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const root = new URL('./samples/', import.meta.url)
const replay = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'))

function send(res, status, content, headers = {}) {
  const type = typeof content === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'
  res.writeHead(status, { 'content-type': type, ...headers })
  res.end(typeof content === 'string' ? content : JSON.stringify(content))
}

function normalizedPath(url) {
  const parsed = new URL(url, 'http://127.0.0.1')
  parsed.searchParams.sort()
  return parsed.pathname + parsed.search
}

function lookup(step, method, path, body) {
  for (let index = step; index >= 0; index--) {
    const candidates = replay.rounds[index].filter(entry =>
      entry.method === method && normalizedPath(entry.path) === path)
    if (!candidates.length) continue
    return candidates.find(entry => entry.request === null ||
      isDeepStrictEqual(entry.request, body))
  }
}

async function input(req) {
  const data = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 65536) throw new Error('提交内容超过测试源容量')
    data.push(chunk)
  }
  const buffer = Buffer.concat(data)
  if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')))
  }
  return buffer.length ? JSON.parse(buffer.toString('utf8')) : null
}

async function sendBinary(req, res, path, asset) {
  const data = await readFile(new URL(asset.file, root))
  const headers = { 'content-type': asset.contentType, etag: `"${asset.digest}"`, 'accept-ranges': 'bytes' }
  if (!req.headers.range) {
    res.writeHead(200, { ...headers, 'content-length': data.length })
    return res.end(data)
  }
  const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/)
  if (!match || Number(match[1]) >= data.length || (match[2] && Number(match[2]) < Number(match[1]))) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${data.length}` })
    return res.end()
  }
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1
  if (asset.slices && !asset.slices.some(([left, right]) => start >= left && end < right)) {
    return send(res, 416, { path, 原因: '请求超出来源保留范围' })
  }
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 })
  return res.end(data.subarray(start, end + 1))
}


export function makeSource() {
  let step = 0

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && ['/ready', '/health'].includes(url.pathname)) {
        return send(res, 200, { status: 'ready', step, steps: replay.rounds.length })
      }
      if (req.method === 'PUT' && url.pathname === '/replay') {
        const body = await input(req)
        if (!Number.isInteger(body?.step) || !replay.rounds[body.step]) {
          return send(res, 400, { 原因: '发布序号不存在' })
        }
        step = body.step
        return send(res, 200, { step })
      }
      const body = req.method === 'POST' ? await input(req) : null

      const path = normalizedPath(req.url)
      const entry = lookup(step, req.method, path, body)
      const asset = replay.assets?.[path]
      if (entry && (asset?.ignoreEarlierResponseFrom === undefined || step < asset.ignoreEarlierResponseFrom)) {
        return send(res, entry.status, entry.body, entry.headers)
      }
      if (req.method === 'GET' && asset && (asset.since ?? 0) <= step) {
        return await sendBinary(req, res, path, asset)
      }
      return send(res, ['GET', 'POST'].includes(req.method) ? 404 : 405, { 原因: '来源没有这项资料或表单组合' })
    } catch {
      return send(res, 400, { 原因: '请求格式不符' })
    }
  })
}
