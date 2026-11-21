import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { makeSourceClient } from '../lib/source-client.mjs'
import {
  buildScope, contractCoverage, isApprovedTransfer, loanWindow, placementOf, resolveContract, sharedService,
} from '../lib/handover.mjs'
import {
  applyCompletion, canCancelReservation, planVisits, poolState,
} from '../lib/capacity.mjs'
import {
  availableServices, confirmSupplement, correctRegistration, explainOrderRetention, mapPrecheckFailure,
  reconcileRegistration, registrationScope, submitRegistration,
} from '../lib/registration.mjs'

const AT = new Date('2026-11-25T10:00:00+08:00')

async function open(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const base = 'http://127.0.0.1:' + server.address().port
  const client = makeSourceClient(base)
  const view = step => client.raw('/replay', { method: 'PUT', body: { step } })
  return { server, base, client, view }
}

const sample = {
  ref: 'H-16', version: 1, from: '检查三室', target: '检查二室',
  loanUntil: '2026-11-28', original: 'NS-03', loaner: 'NS-19',
  state: '原机停用待归还',
  items: [
    { serial: 'P-40', from: 'NS-03', to: 'NS-19', approved: true },
    { serial: 'P-41', from: 'NS-03', to: 'NS-19', approved: false },
    { serial: 'P-42', from: 'NS-03', to: 'NS-19', approved: true },
  ],
}
const contracts = [
  {
    contract: 'S-5', serial: 'NS-03', parts: ['P-40', 'P-41', 'P-42'],
    from: '2026-01-01', through: '2027-01-01', sharedUntil: '2026-11-28',
    sharedServices: ['上门'], servicePool: 'visit-core',
  },
  {
    contract: 'S-8', serial: 'NS-19', parts: ['P-45'],
    from: '2026-01-01', through: '2027-01-01', sharedServices: [], servicePool: 'visit-loaner',
  },
]

test('台账范围：只登记替机与已授权调出的附件，原机与留置附件不复制', () => {
  const scope = registrationScope(sample, contracts, { at: AT })
  assert.deepEqual(scope.entries.map(row => row.serial).sort(), ['NS-19', 'P-40', 'P-42'])
  assert.deepEqual(scope.retained.map(row => row.serial).sort(), ['NS-03', 'P-41'])
  const p41 = scope.retained.find(row => row.serial === 'P-41')
  assert.match(p41.reason, /未授权/)
  assert.equal(scope.window.originalStopped, true)
})

test('停用不等于归还：原机仍持有未授权附件，工单继续挂原机', () => {
  assert.equal(placementOf(sample, 'P-41'), 'original')
  assert.equal(isApprovedTransfer(sample, 'P-41'), false)
  assert.equal(isApprovedTransfer(sample, 'P-40'), true)
  const scope = buildScope(sample, AT)
  assert.ok(scope.originalSerials.includes('P-41'))
  assert.ok(scope.loanerSerials.includes('P-40'))

  const order = { id: 'E-5', serial: 'P-41', host: 'NS-03', status: '待检修' }
  const explained = explainOrderRetention(order, sample, contracts, AT)
  assert.equal(explained.placement, 'original')
  assert.match(explained.reason, /没有获得随替机调出的交接授权/)
  const hostOrder = explainOrderRetention({ id: 'E-7', serial: 'NS-03', status: '待检修' }, sample, contracts, AT)
  assert.match(hostOrder.reason, /停用不等于已归还/)
})

test('交接行 to 回到原机时不算调出，即使 approved 为真', () => {
  const held = structuredClone(sample)
  held.items[0].to = 'NS-03'
  assert.equal(isApprovedTransfer(held, 'P-40'), false)
  assert.equal(placementOf(held, 'P-40'), 'original')
  const scope = registrationScope(held, contracts, { at: AT })
  assert.ok(!scope.entries.some(row => row.serial === 'P-40'))
})

test('临借窗口：主机与替机各保留合同，共享服务需合同列名且未过截止', () => {
  assert.equal(loanWindow(sample, AT).open, true)
  assert.equal(loanWindow(sample, new Date('2026-12-01T00:00:00+08:00')).open, false)

  const loaner = resolveContract(contracts, 'NS-19', sample, AT)
  assert.equal(loaner.contract, 'S-8')
  const original = resolveContract(contracts, 'NS-03', sample, AT)
  assert.equal(original.contract, 'S-5')

  assert.equal(sharedService(contracts[0], '上门', sample, AT).allowed, true)
  assert.equal(sharedService(contracts[1], '上门', sample, AT).allowed, false)
  assert.equal(sharedService(contracts[0], '上门', sample, new Date('2026-11-29T00:00:00+08:00')).allowed, false)

  // 替机合同不会因为临借而继承主机的附件范围。
  const coverage = contractCoverage(contracts[0], 'NS-19', sample, AT)
  assert.equal(coverage.covered, false)
})

test('门户退回必填字段时能回到证据所在的来源', () => {
  const failure = mapPrecheckFailure({
    items: [{ serial: 'P-41', valid: false, need: '交接授权' }],
  })
  assert.deepEqual(failure.missingFields, ['交接授权'])
  assert.equal(failure.evidence[0].evidence, '/handover')
  assert.match(failure.evidence[0].field, /approved/)
})

test('名额按 pool：原机未结束预约占名额，替机预检合格不等于有新名额', () => {
  const capacity = {
    pools: [
      { pool: 'visit-core', limit: 1, coveredContract: 'S-5' },
      { pool: 'visit-loaner', limit: 1, coveredContract: 'S-8' },
    ],
    reservations: [{
      id: 'V-12', serial: 'NS-03', contract: 'S-5', owner: '现场技术员',
      pool: 'visit-core', status: 'confirmed',
      from: '2026-11-25T13:00:00+08:00', to: '2026-11-25T14:00:00+08:00',
    }],
  }
  const plan = planVisits({
    capacity, contracts, handover: sample,
    requests: [{ serial: 'P-40', contract: 'S-5', action: '临借上门' }], at: AT,
  })
  assert.equal(plan.pools.find(row => row.pool === 'visit-core').available, 0)
  assert.equal(plan.blocked.length, 0)
  const shared = plan.plans[0]
  assert.equal(shared.disposition, 'shared')
  assert.equal(shared.newSlot, false)
  assert.equal(shared.share.id, 'V-12')
  assert.match(shared.reason, /可搭 V-12/)

  // 替机自己的 pool 有空位，但那是替机合同的名额，不代表原机 pool 有新名额。
  const loanerPlan = planVisits({
    capacity, contracts, handover: sample,
    requests: [{ serial: 'NS-19', contract: 'S-8', action: '临借上门' }], at: AT,
  })
  assert.equal(loanerPlan.plans[0].pool, 'visit-loaner')
  assert.equal(loanerPlan.plans[0].disposition, 'new-slot')
  assert.equal(poolState(capacity, 'visit-core').available, 0)
})

test('同一 pool 两项同时申请一个名额时只有一项获批，其余阻塞', () => {
  const capacity = { pools: [{ pool: 'visit-core', limit: 1 }], reservations: [] }
  const plan = planVisits({
    capacity, contracts, handover: sample,
    requests: [
      { serial: 'P-40', contract: 'S-5', action: '巡检' },
      { serial: 'P-42', contract: 'S-5', action: '巡检' },
    ],
    at: AT,
  })
  assert.equal(plan.newSlots.length, 1)
  assert.equal(plan.blocked.length, 1)
  assert.match(plan.blocked[0].reason, /竞争/)
})

test('原机续修保留的预约不能用替机登记撤回取消', () => {
  const reservation = {
    id: 'V-12', serial: 'NS-03', pool: 'visit-core', status: 'confirmed',
  }
  const blocked = canCancelReservation(reservation, { handover: sample, reason: '替机撤回' })
  assert.equal(blocked.allowed, false)
  assert.match(blocked.reason, /不能用替机登记的撤回取消/)
  const allowed = canCancelReservation({ ...reservation, serial: 'P-40' }, { handover: sample, reason: '替机撤回' })
  assert.equal(allowed.allowed, true)
})

test('完结回条按合同与服务项释放占用，之后仍看当时的交接授权', () => {
  const capacity = {
    pools: [
      { pool: 'visit-core', limit: 1 },
      { pool: 'visit-loaner', limit: 1 },
    ],
    reservations: [{
      id: 'V-12', serial: 'NS-03', contract: 'S-5', pool: 'visit-core',
      status: 'confirmed', action: '上门', owner: '现场技术员',
    }],
  }
  const result = applyCompletion({
    capacity,
    receipt: { id: 'Z-12', serial: 'P-40', contract: 'S-5', service: '上门' },
    contracts, handover: sample,
    requests: [{ serial: 'P-40', contract: 'S-5', action: '临借上门' }],
    at: AT,
  })
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].id, 'V-12')
  assert.equal(poolState(result.capacity, 'visit-core').available, 1)
  assert.equal(result.eligibility[0].available, 1)
  assert.equal(result.eligibility[0].registrable, true)

  // 释放的是名额不是授权：未授权的附件即便 pool 空出来也不能登记。
  const unauthorised = applyCompletion({
    capacity,
    receipt: { id: 'Z-12', serial: 'P-41', contract: 'S-5', service: '上门' },
    contracts, handover: sample,
    requests: [{ serial: 'P-41', contract: 'S-5', action: '临借上门' }],
    at: AT,
  })
  assert.equal(unauthorised.eligibility[0].transferAuthorized, false)
  assert.equal(unauthorised.eligibility[0].registrable, false)
})

test('登记期间补报附件留在原机：改版后范围变化，旧票据被门户拒', async t => {
  const { client, view } = await open(t)
  await view(1)
  const handover = await client.handover()
  const service = await client.service()
  assert.equal(handover.version, 2)
  assert.equal(isApprovedTransfer(handover, 'P-40'), false)

  // 旧版（版本 1）票据在版本 3 提交 → 门户返回修订冲突。
  const conflict = await client.register({ ticket: 'P-100', revision: 1 })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.state, '修订冲突')

  // 客户端不沿用旧票据，按当前版本重新推导范围：P-40/P-42 都已留置原机。
  const result = await submitRegistration(client, handover, service, {
    at: AT, requests: [{ serial: 'P-40', contract: 'S-5', action: '临借上门' }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'scope')
  assert.match(result.state, /不在本次可登记范围/)
  assert.equal(result.unnoticed[0].serial, 'P-40')
})

test('预检不合格能回到必填字段证据；补交成功后从回执确认', async t => {
  const { client, view } = await open(t)
  await view(1)
  const handover = await client.handover()
  const service = await client.service()

  // 版本 2 的预检里 P-41 仍被判为缺“交接授权”。
  const probe = await client.precheck({
    business: 'H-16', revision: 2,
    items: [{ serial: 'P-41', contract: 'S-5', action: '临借上门' }],
  })
  assert.equal(probe.status, 422)
  const failure = mapPrecheckFailure(probe.body)
  assert.deepEqual(failure.missingFields, ['交接授权'])
  assert.equal(failure.evidence[0].evidence, '/handover')
  assert.match(failure.next, /不要复用这次票据/)

  // 客户端按当前交接记录直接拦在预检之前，同样指回 /handover。
  const result = await submitRegistration(client, handover, service, {
    at: AT, requests: [{ serial: 'P-41', contract: 'S-5', action: '临借上门' }],
  })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'scope')
  assert.equal(result.missing[0].evidence, '/handover')

  // 现场人员为替机补办的服务从回执确认，并标出经办人，不冒用设备代办。
  const receipt = await client.receipt('H-16')
  const supplements = confirmSupplement(receipt, { business: 'H-16', serials: ['NS-19'], owner: '设备代办' })
  assert.equal(supplements.length, 1)
  assert.equal(supplements[0].receipt, 'RR-33')
  assert.equal(supplements[0].signedByOther, true)
})

test('门户 503 时按业务标识查回执，查明后不重提票据', async t => {
  const { client, view } = await open(t)
  await view(0)
  // 版本 1 的登记：门户已收到但返回 503“回执查询中”。
  const response = await client.register({ ticket: 'P-100', revision: 1 })
  assert.equal(response.status, 503)
  // 回执此时还查不到本次登记，不能当作已成功，也不能换票重提。
  const missing = await reconcileRegistration(client, {
    business: 'H-16', serials: ['P-40'], revision: 1, attempts: 1,
  })
  assert.equal(missing.found, false)
  assert.match(missing.next, /不要重复登记/)
  // 门户补出确认行后，同一业务标识可以查明单据。
  await view(1)
  const found = await reconcileRegistration(client, {
    business: 'H-16', serials: ['P-40'], revision: 1, attempts: 1,
  })
  assert.equal(found.found, true)
  assert.equal(found.receiptId, 'RR-17')
  assert.equal(found.receipts[0].owner, '设备代办')
})

test('已登记条目更正：只更正自己签收、同版本、属于本次登记的回执', async t => {
  const { client, view } = await open(t)
  await view(2)
  const handover = await client.handover()
  const service = await client.service()
  assert.equal(handover.version, 3)

  // 同版本、属于本次登记的撤回：门户持有同版本单据，变更已生效。
  const success = await correctRegistration(client, handover, service, {
    business: 'H-16', replaces: 'RR-17', receiptRevision: 1,
    items: [{ serial: 'P-40', contract: 'S-5', action: '撤回临借' }],
    at: AT,
  })
  assert.equal(success.ok, true)
  assert.equal(success.phase, 'already-applied')
  assert.equal(success.state, '已生效（无需重复更正）')
  assert.ok(success.receipts.some(row => row.serial === 'P-40'))

  // 现场技术员签收的 RR-33 不代为更正，按它自己的签收处理。
  const foreign = await correctRegistration(client, handover, service, {
    business: 'H-16', replaces: 'RR-33', receiptRevision: 2,
    items: [{ serial: 'NS-19', contract: 'S-8', action: '上门' }],
    at: AT,
  })
  assert.equal(foreign.ok, false)
  assert.match(foreign.state, /其他经办人/)

  // 回执版本与门户当前持有的版本不符时不能抢改。
  const wrongRevision = await correctRegistration(client, handover, service, {
    business: 'H-16', replaces: 'RR-33', receiptRevision: 1,
    items: [{ serial: 'NS-19', contract: 'S-8', action: '上门' }],
    at: AT, owner: '现场技术员',
  })
  assert.equal(wrongRevision.ok, false)
  assert.match(wrongRevision.state, /版本不符/)
})

test('重复提交同一更正按已生效处理，且不属于本次登记的回执不动', async t => {
  const { client, view } = await open(t)
  await view(2)
  const handover = await client.handover()
  const service = await client.service()

  // 同一更正第二次提交：门户已是撤回确认，不生成第二张单据。
  const repeat = await correctRegistration(client, handover, service, {
    business: 'H-16', replaces: 'RR-17', receiptRevision: 1,
    items: [{ serial: 'P-40', contract: 'S-5', action: '撤回临借' }],
    at: AT,
  })
  assert.equal(repeat.phase, 'already-applied')

  // 不会把一个不相干的序列号塞进本次更正范围。
  const outside = await correctRegistration(client, handover, service, {
    business: 'H-16', replaces: 'RR-17', receiptRevision: 1,
    items: [{ serial: 'X-99', contract: 'S-5', action: '撤回临借' }],
    at: AT,
  })
  assert.equal(outside.ok, false)
  assert.match(outside.state, /不属于本次登记|没有/)
})

test('回执核对能按业务标识与有效范围区分别人的签收', async t => {
  const { client, view } = await open(t)
  await view(2)
  const none = await reconcileRegistration(client, {
    business: 'H-16', serials: ['P-40'], revision: 2, owner: '设备代办',
  })
  assert.equal(none.found, false)

  const theirs = await reconcileRegistration(client, {
    business: 'H-16', serials: ['NS-19'], revision: 2, owner: '现场技术员',
  })
  assert.equal(theirs.found, true)
  assert.equal(theirs.receiptId, 'RR-33')
})

test('科室视角只列已确认适用部分，并给出待人工接手与具名占用', async t => {
  const { client, view } = await open(t)
  await view(1)
  const handover = await client.handover()
  const service = await client.service()
  const receipts = await client.receipt('H-16')
  const capacity = await client.capacity()
  const viewReport = availableServices({ handover, contracts: service, receipts, capacity, at: AT })
  assert.deepEqual(viewReport.confirmed.map(row => row.serial), ['NS-19'])
  assert.equal(viewReport.confirmed[0].receiptOwner, '现场技术员')
  assert.ok(viewReport.pendingManual.some(row => row.serial === 'P-41'))
  // 停用不等于已归还：原机也在待人工接手清单里。
  assert.ok(viewReport.pendingManual.some(row => row.serial === 'NS-03'))
  assert.equal(viewReport.occupancies[0].reservation, 'V-12')
  assert.equal(viewReport.occupancies[0].owner, '现场技术员')
})

test('版本 3 补报 P-42 留置后，维护清单随之改变', async t => {
  const { client, view } = await open(t)
  await view(2)
  const handover = await client.handover()
  const service = await client.service()
  const scope = registrationScope(handover, service, { at: AT })
  assert.ok(!scope.entries.some(row => row.serial === 'P-42'))
  assert.ok(scope.retained.some(row => row.serial === 'P-42'))
  // 随后又补回授权，维护清单只含重新授权的附件。
  await view(3)
  const latest = await client.handover()
  const after = registrationScope(latest, service, { at: AT })
  assert.ok(after.entries.some(row => row.serial === 'P-42'))
})

test('成功登记后回执与维护清单只含本次范围', async t => {
  const { client, view } = await open(t)
  await view(3)
  const handover = await client.handover()
  const service = await client.service()
  const result = await submitRegistration(client, handover, service, {
    at: AT,
    requests: [{ serial: 'P-42', contract: 'S-5', action: '临借上门' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'registered')
  assert.deepEqual(result.scope, ['P-42'])
  assert.equal(result.receiptId, 'RR-48')
  assert.deepEqual(result.maintenanceList.map(row => row.serial), ['P-42'])
  assert.ok(!result.maintenanceList.some(row => row.serial === 'NS-03'))
})
