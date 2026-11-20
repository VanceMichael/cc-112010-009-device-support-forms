import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { makeSource } from '../source.mjs'

const release = JSON.parse(await readFile(new URL('../samples/sources.json', import.meta.url), 'utf8'))
const entries = [["/handover", "/service", "/orders", "/receipt?business=H-16", "/precheck", "/registration"], ["/receipt?business=H-16", "/handover", "/precheck", "/registration"], ["/receipt?business=H-16", "/precheck", "/registration"]]

async function openSource(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return new URL('http://127.0.0.1:' + server.address().port)
}

function request(origin, path, options) {
  return fetch(new URL(path, origin), { signal: AbortSignal.timeout(3000), ...options })
}

async function view(origin, step) {
  const res = await request(origin, '/replay', { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step }) })
  assert.equal(res.status, 200)
}

test('逐次发布可从资料源取回', async t => {
  const origin = await openSource(t)
  const ready = await request(origin, '/ready')
  assert.deepEqual(await ready.json(), { status: 'ready', step: 0, steps: release.rounds.length })
  for (const [step, routes] of entries.entries()) {
    await view(origin, step)
    for (const entry of release.rounds[step].filter(row => routes.includes(row.path))) {
      const options = { method: entry.method }
      if (entry.request !== null) {
        options.body = JSON.stringify(entry.request)
        options.headers = { 'content-type': 'application/json' }
      }
      const response = await request(origin, entry.path, options)
      assert.equal(response.status, entry.status, entry.path)
      if (typeof entry.body === 'string') {
        assert.equal(await response.text(), entry.body, entry.path)
      } else {
        assert.deepEqual(await response.json(), entry.body, entry.path)
      }
    }
  }
})

test('二进制资料摘要和传输范围一致', { skip: !Object.keys(release.assets).length }, async t => {
  const origin = await openSource(t)
  for (const [path, asset] of Object.entries(release.assets)) {
    await view(origin, asset.since ?? asset.ignoreEarlierResponseFrom ?? 0)
    const response = await request(origin, path)
    assert.equal(response.status, 200, path)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.digest)
    const partial = await request(origin, path, { headers: { range: 'bytes=0-7' } })
    assert.equal(partial.status, 206, path)
    assert.equal(partial.headers.get('content-range'), 'bytes 0-7/' + bytes.length)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 8))
  }
})

test('随访完结和附件授权独立发布，现场登记继续可核对', async t => {
  const origin = await openSource(t)
  const read = async path => (await request(origin, path)).json()
  await view(origin, 1)
  const pending = await read('/visit-capacity')
  const contract = (await read('/service')).find(row => row.contract === 'S-5')
  const held = pending.reservations.find(row => row.pool === contract.servicePool)
  assert.equal(held.status, 'confirmed')
  assert.equal(held.serial, 'NS-03')
  assert.equal((await read('/handover')).items.find(row => row.serial === 'P-42').approved, true)
  await view(origin, 2)
  const completed = (await read('/visit-capacity')).reservations.find(row => row.id === held.id)
  assert.equal(completed.status, 'completed')
  assert.equal((await read('/handover')).items.find(row => row.serial === 'P-42').approved, false)
  const book = await read('/receipt?business=H-16')
  assert.equal(book.statements.find(row => row.id === 'RR-33').status, '已确认')
  await view(origin, 3)
  const latest = await read('/handover')
  assert.equal(latest.items.find(row => row.serial === 'P-42').approved, true)
  const post = (path, body) => request(origin, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const check = await post('/precheck', { business: latest.ref, revision: latest.version,
    items: [{ serial: 'P-42', contract: 'S-5', action: '临借上门' }],
  })
  const { ticket } = await check.json()
  const registration = await post('/registration', { ticket, revision: latest.version })
  assert.equal(registration.status, 200)
  assert.equal((await read('/receipt?business=H-16')).statements.find(row => row.id === 'RR-48').serial, 'P-42')
})
