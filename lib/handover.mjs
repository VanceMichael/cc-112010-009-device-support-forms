/**
 * 交接记录与合同适用范围的推导。
 *
 * 现场规则：
 *  - 主机、探头各自有独立序列号；附件是否随设备调往其他科室，只看有授权的交接行。
 *  - 停用不等于已经归还：state 为“原机停用待归还”时，原机虽不再使用，未授权/未
 *    经交接的附件仍挂在原机上，不能当成全套已移走。
 *  - 附件可以单独留置：to === from 表示仍留在原机。
 *  - 临借窗口内两台机器各自保留原有合同；共享上门服务只在合同列名且
 *    sharedUntil 之前成立，不是替机继承主机合同。
 *  - 只有 approved 且确实调出的行，才是替机登记的实际序列范围。
 */

import { afterDay, parseDayStart } from './dates.mjs'

export const STOPPED_STATES = new Set(['原机停用待归还', '停用待归还', '待归还'])

export function itemBySerial(handover, serial) {
  return (handover?.items ?? []).find(row => row.serial === serial) ?? null
}

/** 临借窗口是否仍开放。loanUntil 为空表示归还时间待定，窗口尚未关闭。 */
export function isLoanOpen(handover, at = new Date()) {
  if (!handover?.loanUntil) return true
  return !afterDay(handover.loanUntil, at)
}

/** 窗口信息；stopped 只说明原机停用，不说明已经归还。 */
export function loanWindow(handover, at = new Date()) {
  return {
    open: isLoanOpen(handover, at),
    loanUntil: handover?.loanUntil ?? null,
    originalStopped: STOPPED_STATES.has(handover?.state),
    state: handover?.state ?? null,
  }
}

/** 一条交接行是否把附件授权调离原机。未授权、仍回原机都不算移走。 */
export function isApprovedTransfer(handover, serialOrRow) {
  const row = typeof serialOrRow === 'string' ? itemBySerial(handover, serialOrRow) : serialOrRow
  if (!row) return false
  return row.approved === true && Boolean(row.to) && row.to !== row.from
}

/** 附件在这次交接后的落点：loaner、original、elsewhere。 */
export function placementOf(handover, serial) {
  if (serial === handover?.loaner) return 'loaner'
  if (serial === handover?.original) return 'original'
  const row = itemBySerial(handover, serial)
  if (!row) return null
  if (!isApprovedTransfer(handover, row)) return 'original'
  return row.to === handover.loaner ? 'loaner' : 'elsewhere'
}

/**
 * 按交接记录展开本次实际序列范围。
 * 主机和附件都单独列行，绝不把原机整份服务单的附件范围复制给替机。
 */
export function buildScope(handover, at = new Date()) {
  if (!handover) throw new Error('缺少交接记录')
  const window = loanWindow(handover, at)
  const hosts = [
    {
      serial: handover.original,
      role: '主机',
      placement: 'original',
      stopped: window.originalStopped,
      note: window.originalStopped ? '原机停用待归还；停用不等于已归还' : '原机仍在使用',
    },
    {
      serial: handover.loaner,
      role: '主机',
      placement: 'loaner',
      stopped: false,
      note: '替机，使用替机自己的合同',
    },
  ]
  const parts = (handover.items ?? []).map(row => {
    const placement = placementOf(handover, row.serial)
    return {
      serial: row.serial,
      role: '附件',
      from: row.from ?? null,
      to: row.to ?? null,
      approved: row.approved === true,
      transferAuthorized: isApprovedTransfer(handover, row),
      placement,
      note: placement === 'loaner'
        ? '已授权随替机'
        : row.approved === true && row.to === row.from
          ? '仍在原机（交接行为留置）'
          : row.approved === true
            ? '已授权调往其他科室'
            : '未获交接授权，仍按原机保管',
    }
  })
  return {
    business: handover.ref ?? null,
    version: handover.version ?? null,
    from: handover.from ?? null,
    target: handover.target ?? null,
    window,
    hosts,
    parts,
    loanerSerials: [
      handover.loaner,
      ...parts.filter(part => part.placement === 'loaner').map(part => part.serial),
    ].filter(Boolean),
    originalSerials: [
      handover.original,
      ...parts.filter(part => part.placement === 'original').map(part => part.serial),
    ].filter(Boolean),
    elsewhereSerials: parts.filter(part => part.placement === 'elsewhere').map(part => part.serial),
  }
}

/**
 * 合同对某序列号的适用范围。
 *
 * covered 表示“合同在有效期内包含这个序列号”；registrable 表示“本次能按替机
 * 范围登记”。两者分开，才不会把留在原机的附件误判成没有合同。
 */
export function contractCoverage(contract, serial, handover, at = new Date()) {
  if (!contract) return { covered: false, registrable: false, serial, reason: '没有对应的合同' }
  const start = parseDayStart(contract.from)
  if (start && at < start) {
    return { covered: false, registrable: false, serial, contract: contract.contract, reason: '合同尚未生效' }
  }
  if (afterDay(contract.through, at)) {
    return { covered: false, registrable: false, serial, contract: contract.contract, reason: '合同已过有效期' }
  }

  if (contract.serial === serial) {
    return {
      covered: true,
      registrable: !handover || serial === handover.loaner,
      serial,
      contract: contract.contract,
      reason: '主机在该合同内',
      host: true,
    }
  }
  if (!(contract.parts ?? []).includes(serial)) {
    return {
      covered: false,
      registrable: false,
      serial,
      contract: contract.contract,
      reason: '该序列号不在合同附件范围',
    }
  }
  if (!handover) {
    return { covered: true, registrable: true, serial, contract: contract.contract, reason: '附件在合同内' }
  }
  const row = itemBySerial(handover, serial)
  if (!row) {
    return {
      covered: true,
      registrable: false,
      serial,
      contract: contract.contract,
      reason: '附件在合同内，但交接记录未单列，不能按替机登记',
    }
  }
  const placement = placementOf(handover, serial)
  if (placement === 'loaner') {
    return {
      covered: true,
      registrable: true,
      serial,
      contract: contract.contract,
      reason: '已授权随替机，仍在原合同附件范围',
      transferred: true,
    }
  }
  if (placement === 'original') {
    return {
      covered: true,
      registrable: false,
      serial,
      contract: contract.contract,
      reason: row.approved === true
        ? '附件仍留在原机，继续由原机合同承担'
        : '交接未授权随替机调出，仍由原机合同承担',
      transferred: false,
    }
  }
  return {
    covered: false,
    registrable: false,
    serial,
    contract: contract.contract,
    reason: '附件已调往其他科室，不在本次登记范围',
    transferred: true,
  }
}

/** 预留共享服务是否成立：合同列名 + 在 sharedUntil 之前 + 临借窗口仍开。 */
export function sharedService(contract, service, handover, at = new Date()) {
  if (!contract || !service) return { allowed: false, reason: '缺少合同或服务项' }
  if (!(contract.sharedServices ?? []).includes(service)) {
    return { allowed: false, reason: `合同 ${contract.contract} 未列明共享服务“${service}”` }
  }
  if (!contract.sharedUntil) return { allowed: false, reason: '合同没有共享截止时间' }
  if (afterDay(contract.sharedUntil, at)) {
    return { allowed: false, reason: `共享截止时间 ${contract.sharedUntil} 已过` }
  }
  if (!isLoanOpen(handover, at)) {
    return { allowed: false, reason: `临借窗口已于 ${handover.loanUntil} 结束` }
  }
  return {
    allowed: true,
    reason: `临借窗口内共享“${service}”，截止 ${contract.sharedUntil}`,
    until: contract.sharedUntil,
  }
}

/** 为一个序列号挑选合同；主机优先自己的合同，附件优先原机合同。 */
export function resolveContract(contracts, serial, handover, at = new Date()) {
  const candidates = (contracts ?? [])
    .map(contract => ({ contract, coverage: contractCoverage(contract, serial, handover, at) }))
    .filter(candidate => candidate.coverage.covered)
  if (!candidates.length) return null
  return candidates.sort((left, right) => {
    const leftExact = left.contract.serial === serial ? 0 : 1
    const rightExact = right.contract.serial === serial ? 0 : 1
    if (leftExact !== rightExact) return leftExact - rightExact
    const leftOriginal = left.contract.serial === handover?.original ? 0 : 1
    const rightOriginal = right.contract.serial === handover?.original ? 0 : 1
    return leftOriginal - rightOriginal
  })[0].contract
}

/** 只做一个只读摘要，供报告和事后解释使用。 */
export function summarizeHandover(handover, at = new Date()) {
  const scope = buildScope(handover, at)
  return {
    business: scope.business,
    revision: scope.version,
    from: scope.from,
    target: scope.target,
    window: scope.window,
    original: scope.hosts[0],
    loaner: scope.hosts[1],
    loanerScope: scope.loanerSerials,
    originalScope: scope.originalSerials,
    parts: scope.parts,
    pendingManual: [
      ...(scope.window.originalStopped ? [{ serial: handover.original, role: '主机', reason: '原机停用待归还，尚未归还' }] : []),
      ...scope.parts
        .filter(part => part.placement !== 'loaner')
        .map(part => ({ serial: part.serial, role: '附件', reason: part.note })),
    ],
  }
}

