/**
 * 随访/上门名额与预约占用。
 *
 * 规则：
 *  - 厂商按 pool 记录名额，不按主机型号；有的 pool 由原机和附件共享（合同 servicePool），
 *    有的给替机另开一个 pool（替机自己的合同）。
 *  - confirmed 预约仍占用名额；completed 是收到完结回条后的事实，释放占用。
 *  - 预检合格只说明资料可登记，绝不等于有新名额。
 *  - 原机尚未结束的预约仍占它 pool 的名额；不能因为替机的临借预检合格就报“有新名额”。
 *  - 合同列明共享服务时，临借窗口内一项上门可以由原机与附件共用（不新增名额）。
 *  - 为原机续修保留的预约，不能被替机登记撤回捎带取消。
 */

import { isApprovedTransfer } from './handover.mjs'
import { afterDay } from './dates.mjs'

export const ACTIVE_STATUSES = new Set(['confirmed', 'pending', '待确认', '使用中'])
export const RELEASED_STATUSES = new Set(['completed', 'cancelled', 'withdrawn', '已完结', '已取消', '已撤回'])

export function isActive(reservation) {
  if (!reservation) return false
  if (RELEASED_STATUSES.has(reservation.status)) return false
  return ACTIVE_STATUSES.has(reservation.status)
}

export function occupantLabel(reservation) {
  const when = reservation.from && reservation.to ? `${reservation.from}~${reservation.to}` : '时段未公布'
  return `${reservation.id}（${reservation.serial}，${reservation.owner ?? '未具名'}，${reservation.status}，${when}）`
}

export function poolIndex(capacity) {
  return new Map((capacity?.pools ?? []).map(pool => [pool.pool, pool]))
}

/** 哪些合同是否覆盖某序列号。 */
function coveringContracts(contracts, serial) {
  return (contracts ?? []).filter(contract =>
    contract.serial === serial || (contract.parts ?? []).includes(serial))
}

/** 某序列号对应的名额池（按覆盖它的合同上的 servicePool）。 */
export function poolsForSerial(capacity, contracts, serial) {
  const pools = []
  for (const contract of coveringContracts(contracts, serial)) {
    if (!contract.servicePool) continue
    const pool = poolIndex(capacity).get(contract.servicePool)
    if (pool) pools.push({ contract, pool })
  }
  return pools
}

/** 一个 pool 的占用情况；占用者逐个具名，便于科室追问“谁占的”。 */
export function poolState(capacity, poolName) {
  const pool = poolIndex(capacity).get(poolName) ?? { pool: poolName, limit: 0 }
  const occupants = (capacity?.reservations ?? []).filter(row => row.pool === poolName && isActive(row))
  return {
    pool: poolName,
    limit: pool.limit ?? 0,
    used: occupants.length,
    available: Math.max(0, (pool.limit ?? 0) - occupants.length),
    occupants,
    coveredContract: pool.coveredContract ?? null,
  }
}

export function capacitySnapshot(capacity) {
  return {
    pools: (capacity?.pools ?? []).map(pool => poolState(capacity, pool.pool)),
    reservations: (capacity?.reservations ?? []).map(row => ({
      ...row,
      active: isActive(row),
      label: occupantLabel(row),
    })),
  }
}

/** 服务项是否算同一项；“临借上门”可以落在“上门”上，但“巡检”不行。 */
export function serviceMatches(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return longer.includes(shorter)
}

/** 合同是否允许在临借窗口共享某项服务。 */
export function shareAllowed(contract, service, handover, at = new Date()) {
  if (!contract) return { allowed: false, reason: '缺少合同' }
  const listed = (contract.sharedServices ?? []).find(row => serviceMatches(service, row))
  if (!listed) {
    return { allowed: false, reason: `合同 ${contract.contract} 未列明可共享“${service}”` }
  }
  if (!contract.sharedUntil) {
    return { allowed: false, reason: `合同 ${contract.contract} 没有共享截止时间` }
  }
  if (afterDay(contract.sharedUntil, at)) {
    return { allowed: false, reason: `合同 ${contract.contract} 的共享截止 ${contract.sharedUntil} 已过` }
  }
  if (handover?.loanUntil && afterDay(handover.loanUntil, at)) {
    return { allowed: false, reason: `临借窗口已于 ${handover.loanUntil} 结束` }
  }
  return { allowed: true, reason: `临借窗口内可共享“${listed}”`, service: listed, until: contract.sharedUntil }
}

function resolveRequestContract(contracts, request) {
  if (request.contract) {
    const exact = (contracts ?? []).find(row => row.contract === request.contract)
    if (exact) return exact
  }
  const covering = coveringContracts(contracts, request.serial)
  return covering.find(row => row.serial === request.serial) ?? covering[0] ?? null
}

function existingShare(capacity, contract, handover, request, at) {
  const allowed = shareAllowed(contract, request.action, handover, at)
  if (!allowed.allowed) return { allowed: false, reason: allowed.reason }
  const candidates = (capacity?.reservations ?? []).filter(row =>
    row.pool === contract.servicePool &&
    isActive(row) &&
    row.serial !== request.serial &&
    serviceMatches(request.action, row.action ?? allowed.service) &&
    (row.contract === contract.contract || coveringContracts([contract], row.serial).length > 0))
  if (!candidates.length) {
    return { allowed: false, reason: '窗口允许共享，但当前没有可搭的具名预约' }
  }
  return { allowed: true, reason: `${allowed.reason}，可搭 ${candidates[0].id}`, reservation: candidates[0] }
}

function batchShare(entries, contract, handover, request, at) {
  const allowed = shareAllowed(contract, request.action, handover, at)
  if (!allowed.allowed) return { allowed: false, reason: allowed.reason }
  const hostPlan = entries.find(entry =>
    entry.disposition === 'new-slot' &&
    entry.pool === contract.servicePool &&
    entry.serial !== request.serial &&
    serviceMatches(request.action, entry.request.action ?? allowed.service))
  if (!hostPlan) {
    return { allowed: false, reason: '同批没有可共用的上门名额' }
  }
  return {
    allowed: true,
    reason: `${allowed.reason}，与同批 ${hostPlan.serial} 共用一次上门（不新增名额）`,
    reservation: null,
    batchWith: hostPlan.serial,
  }
}

/**
 * 汇总一批登记的占用需求。
 * requests: [{ serial, contract?, action }]
 * 返回的 dispositions：new-slot（占一个新名额）、shared（搭已有具名预约）、
 * shared-batch（搭同批的一次上门）、blocked。
 */
export function planVisits({ capacity, contracts, handover, requests, at = new Date() }) {
  const plans = []
  const byPool = new Map()

  for (const request of requests ?? []) {
    const contract = resolveRequestContract(contracts, request)
    const state = contract?.servicePool ? poolState(capacity, contract.servicePool) : null
    plans.push({
      request,
      serial: request.serial,
      contract: contract?.contract ?? null,
      pool: state?.pool ?? null,
      limit: state?.limit ?? 0,
      used: state?.used ?? 0,
      available: state?.available ?? 0,
      occupants: state?.occupants ?? [],
      share: null,
      disposition: 'pending',
      reason: '',
    })
    if (state && !byPool.has(state.pool)) byPool.set(state.pool, [])
    if (state) byPool.get(state.pool).push(plans.at(-1))
  }

  for (const [pool, entries] of byPool) {
    const state = poolState(capacity, pool)
    let remaining = state.available
    for (const entry of entries) {
      const contract = resolveRequestContract(contracts, entry.request)
      if (remaining > 0) {
        remaining -= 1
        entry.disposition = 'new-slot'
        entry.newSlot = true
        entry.reason = `pool ${pool} 分配到一个名额（分配后剩余 ${remaining}）`
        continue
      }
      const existing = entry.contract ? existingShare(capacity, contract, handover, entry.request, at) : { allowed: false }
      if (existing.allowed) {
        entry.disposition = 'shared'
        entry.newSlot = false
        entry.share = {
          id: existing.reservation.id,
          serial: existing.reservation.serial,
          owner: existing.reservation.owner,
          from: existing.reservation.from,
          to: existing.reservation.to,
        }
        entry.reason = existing.reason
        continue
      }
      const batch = contract ? batchShare(entries, contract, handover, entry.request, at) : { allowed: false }
      if (batch.allowed) {
        entry.disposition = 'shared-batch'
        entry.newSlot = false
        entry.share = { batchWith: batch.batchWith, reservation: null }
        entry.reason = batch.reason
        continue
      }
      entry.disposition = 'blocked'
      entry.newSlot = false
      const competitors = entries.filter(row => row !== entry).map(row => row.serial)
      entry.reason = `pool ${pool} 名额已满：占用者 ${state.occupants.map(occupantLabel).join('；') || '无'}；` +
        (competitors.length
          ? `同批申请 ${competitors.join('、')} 与本项竞争 ${state.limit} 个名额；`
          : '') +
        `共享不可用：${existing.reason ?? batch.reason ?? '合同未列明共享服务'}`
    }
  }

  // 没有 pool 的请求单独标出，不静默当作有名额。
  for (const entry of plans.filter(row => row.disposition === 'pending')) {
    entry.disposition = 'blocked'
    entry.newSlot = false
    entry.reason = '找不到该序列号对应的名额池/合同'
  }

  return {
    plans,
    pools: [...byPool.keys()].map(pool => ({
      ...poolState(capacity, pool),
      requests: byPool.get(pool).map(entry => entry.serial),
    })),
    blocked: plans.filter(plan => plan.disposition === 'blocked'),
    shared: plans.filter(plan => plan.disposition === 'shared' || plan.disposition === 'shared-batch'),
    newSlots: plans.filter(plan => plan.disposition === 'new-slot'),
    note: '预检通过不代表有空余名额；可用名额以 pool 的 confirmed 占用为准，completed 回条释放占用。',
  }
}

/**
 * 替机登记撤回时能否顺带取消某预约。
 * 为原机续修保留的预约不能因替机撤回而消失。
 */
export function canCancelReservation(reservation, { handover, reason = '', actor = '' } = {}) {
  if (!reservation) return { allowed: false, reason: '预约不存在' }
  if (!isActive(reservation)) return { allowed: false, reason: '预约已不占用名额' }
  const loanerDriven = actor === 'loaner' || reason.includes('替机')
  if (handover && reservation.serial === handover.original && loanerDriven) {
    return {
      allowed: false,
      reason: `预约 ${reservation.id} 属于原机 ${handover.original}，可能是为续修保留的；不能用替机登记的撤回取消`,
    }
  }
  return { allowed: true, reason: `可按业务归属撤回 ${reservation.id}` }
}

/**
 * 完结回条是否对应这条预约。
 * 优先按回条号/预约号精确对上；否则按合同 + 实际服务项释放——共享上门可能由
 * 随行附件签收，回条上的序列号未必等于预约最初登记的主机序列号。
 */
function completionMatches(reservation, receipt) {
  if (receipt.id && reservation.receipt === receipt.id) return true
  if (receipt.reservation && reservation.id === receipt.reservation) return true
  if (receipt.business && reservation.business && reservation.business !== receipt.business) return false
  if (receipt.contract && reservation.contract !== receipt.contract) return false
  if (receipt.service && !serviceMatches(receipt.service, reservation.action ?? receipt.service)) return false
  if (receipt.serial && receipt.contract && receipt.service) return true
  if (receipt.serial && !receipt.contract && !receipt.service) return reservation.serial === receipt.serial
  return Boolean(receipt.contract && receipt.service)
}

/**
 * 收到以前的服务完结回条：按合同和实际服务项释放占用；随后按当时仍然有效的
 * 临借授权判断能不能登记。返回释放了谁、释放后谁还有资格。
 */
export function applyCompletion({ capacity, receipt, contracts = [], handover = null, requests = [], at = new Date() }) {
  const copy = structuredClone(capacity ?? { pools: [], reservations: [] })
  const released = []
  for (const reservation of copy.reservations ?? []) {
    if (!isActive(reservation)) continue
    if (!completionMatches(reservation, receipt)) continue
    reservation.status = 'completed'
    if (receipt.id) reservation.receipt = receipt.id
    released.push({
      id: reservation.id,
      pool: reservation.pool,
      serial: reservation.serial,
      contract: reservation.contract,
      action: reservation.action ?? null,
      owner: reservation.owner ?? null,
      receipt: receipt.id ?? null,
    })
  }

  // 释放的是名额，不是授权：替机能不能登记仍要看“现在”的交接行。
  const eligibility = (requests ?? []).map(request => {
    const transferred = request.serial === handover?.loaner
      ? true
      : handover
        ? isApprovedTransfer(handover, request.serial) || request.serial === handover.original
        : null
    const plan = planVisits({ capacity: copy, contracts, handover, requests: [request], at }).plans[0]
    return {
      serial: request.serial,
      action: request.action,
      pool: plan.pool,
      available: plan.available,
      disposition: plan.disposition,
      transferAuthorized: transferred,
      registrable: transferred === true && plan.disposition !== 'blocked',
      reason: transferred === false
        ? `释放后 pool ${plan.pool} 有 ${plan.available} 个名额，但当前交接未授权 ${request.serial} 随替机登记`
        : plan.reason,
    }
  })

  return {
    released,
    capacity: copy,
    eligibility,
    note: '完结回条只释放名额；能否为替机登记仍按释放时有效的交接授权重新预检。',
  }
}

/** 仍待人工接手的机器/附件（停用未归还、未授权、留置原机）。 */
export function partsAwaitingManual(handover) {
  const pending = []
  if (handover?.state && handover.state.includes('停用')) {
    pending.push({ serial: handover.original, role: '主机', reason: handover.state })
  }
  for (const row of handover?.items ?? []) {
    if (row.approved !== true) {
      pending.push({ serial: row.serial, role: '附件', reason: '交接未授权，仍按原机保管' })
    } else if (row.to === row.from) {
      pending.push({ serial: row.serial, role: '附件', reason: '留置原机' })
    }
  }
  return pending
}
