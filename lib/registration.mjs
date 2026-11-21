/**
 * 门户预检/登记/更正。
 *
 * 现场规则：
 *  - 只按“这次实际需要登记的序列范围”提交，不复制原机整份服务单。
 *  - 预检票据带版本；登记期间交接记录改版（如技术员补报另一件附件留在原机），
 *    表单适用范围和即将出具的维护清单都会变，旧票据不能继续用。
 *  - 门户已收到登记但客户端没拿到回执时（503/网络中断），先按业务标识与有效范围
 *    查 /receipt，不盲目重提。
 *  - 已经登记成功的条目，只有门户仍持有同一版本单据、且能确认变更属于本次登记时
 *    才用替代票据更正；被别人改过的回执（owner/revision 变化）一律不抢改。
 *  - 同一业务号下现场人员为替机自己补办的服务按其签收处理，不能当成设备代办的登记
 *    去更正或撤回。
 */

import {
  buildScope, contractCoverage, isApprovedTransfer, itemBySerial, loanWindow, placementOf, resolveContract,
} from './handover.mjs'

export const REQUIRED_FIELDS = {
  交接授权: {
    field: 'handover.items[].approved',
    evidence: '/handover',
    hint: '交接记录必须有该附件的 approved: true 行，且 to 指向替机；未授权或仍回原机都不算移走',
  },
  合同: {
    field: 'service[].contract',
    evidence: '/service',
    hint: '需要该序列号对应的、仍在有效期内的合同',
  },
  合同范围: {
    field: 'service[].parts',
    evidence: '/service',
    hint: '附件必须出现在合同 parts 中，且交接授权其随替机',
  },
  序列号: {
    field: 'handover.original / handover.loaner',
    evidence: '/handover',
    hint: '主机与探头各有独立序列号，需确认本次登记对象',
  },
  名额: {
    field: 'visit-capacity.pools[].limit',
    evidence: '/visit-capacity',
    hint: '名额按 pool 计；confirmed 预约仍占用，预检合格不代表有空余名额',
  },
}

export function explainNeed(need) {
  const match = REQUIRED_FIELDS[need]
  if (match) return { need, ...match }
  return { need, field: '未知字段', evidence: null, hint: '门户未给出可映射的必填字段，需要人工核对' }
}

/**
 * 从交接记录推出本次要登记的条目。
 *
 * 默认只登记“替机 + 已授权随替机调出的附件”：原机自己的合同在临借窗口内仍然
 * 有效，不需要、也不应重新登记，否则等于把原机的整份服务单复制给替机。
 * 原机和留置原机的附件单独放在 retained 里，并给出未处理原因。
 */
export function registrationScope(handover, contracts, { at = new Date(), include = null } = {}) {
  const scope = buildScope(handover, at)
  const entries = []
  const excluded = []
  const retained = []

  const consider = (serial, role) => {
    if (include && !include.includes(serial)) {
      excluded.push({ serial, role, reason: '不在本次指定范围' })
      return
    }
    const placement = placementOf(handover, serial)
    if (placement === 'elsewhere') {
      excluded.push({ serial, role, reason: '已调往其他科室，不属于本次登记范围' })
      return
    }
    const contract = resolveContract(contracts, serial, handover, at)
    if (!contract) {
      excluded.push({
        serial,
        role,
        reason: '没有覆盖该序列号的有效合同',
        coverage: contracts.map(item => ({ contract: item.contract, ...contractCoverage(item, serial, handover, at) })),
      })
      return
    }
    const coverage = contractCoverage(contract, serial, handover, at)
    if (!coverage.covered) {
      excluded.push({ serial, role, reason: coverage.reason, contract: contract.contract })
      return
    }
    if (!coverage.registrable) {
      excluded.push({
        serial,
        role,
        reason: coverage.reason,
        contract: contract.contract,
        coverage,
        needs: coverage.transferred === false ? [] : ['交接授权'],
      })
      return
    }
    entries.push({
      serial,
      role,
      contract: contract.contract,
      pool: contract.servicePool ?? null,
      coverage,
      row: itemBySerial(handover, serial),
      placement,
      handoverVersion: handover.version,
    })
  }

  // 本次要登记的：替机主机 + 已授权随替机调出的附件。
  consider(handover.loaner, '主机')
  for (const row of handover.items ?? []) {
    if (isApprovedTransfer(handover, row)) {
      consider(row.serial, '附件')
      continue
    }
    retained.push({
      serial: row.serial,
      role: '附件',
      placement: placementOf(handover, row.serial),
      approved: row.approved === true,
      from: row.from ?? null,
      to: row.to ?? null,
      reason: row.to === row.from ? '交接行是留置原机，仍由原机合同承担' : '交接未授权随替机调出，仍由原机合同承担',
      evidence: '/handover',
    })
    if (include?.includes(row.serial)) {
      excluded.push({ serial: row.serial, role: '附件', reason: '交接未授权，不能按替机范围登记', needs: ['交接授权'] })
    }
  }

  // 原机：停用不等于归还，它的合同仍然有效，但默认不重新登记。
  // 只有现场明确指定原机（例如为原机续修单独登记）时才进入本次范围。
  if (include?.includes(handover.original)) {
    const contract = resolveContract(contracts, handover.original, handover, at)
    const coverage = contract ? contractCoverage(contract, handover.original, handover, at) : null
    if (contract && coverage?.covered) {
      entries.push({
        serial: handover.original,
        role: '主机',
        contract: contract.contract,
        pool: contract.servicePool ?? null,
        coverage: { ...coverage, registrable: true },
        row: null,
        placement: 'original',
        handoverVersion: handover.version,
      })
    } else {
      excluded.push({
        serial: handover.original,
        role: '主机',
        reason: coverage?.reason ?? '没有覆盖原机的有效合同',
        needs: ['合同'],
      })
    }
  }
  if (!include || include.includes(handover.original)) {
    retained.push({
      serial: handover.original,
      role: '主机',
      placement: 'original',
      approved: null,
      reason: scope.window.originalStopped
        ? `原机${handover.state.replace(/^原机/, '')}；停用不等于已归还，原合同继续覆盖原机及未调出的附件`
        : '原机仍在使用，原合同继续有效，不需要重新登记',
      evidence: '/handover',
    })
  }

  return {
    business: handover.ref,
    revision: handover.version,
    window: loanWindow(handover, at),
    entries,
    retained,
    excluded,
    loanerScope: scope.loanerSerials,
    originalScope: scope.originalSerials,
    pendingManual: scope.parts.filter(part => part.placement !== 'loaner'),
  }
}

function actionFor(entry) {
  // 门户按 action 判断共享/临借；默认值由角色和落点决定。
  if (entry.role === '主机' && entry.placement === 'loaner') return '临借上门'
  if (entry.placement === 'loaner') return '临借上门'
  return '续修'
}

export function buildPrecheckBody(handover, entries, { requests = [] } = {}) {
  const bySerial = new Map((requests ?? []).map(row => [row.serial, row]))
  return {
    business: handover.ref,
    revision: handover.version,
    items: entries.map(entry => {
      const request = bySerial.get(entry.serial) ?? {}
      return {
        serial: entry.serial,
        contract: request.contract ?? entry.contract,
        action: request.action ?? actionFor(entry),
      }
    }),
  }
}

/** 预检应答里的不合格项映射回必填字段与证据。 */
export function mapPrecheckFailure(body) {
  const items = (body?.items ?? []).map(row => ({
    serial: row.serial,
    valid: row.valid !== false,
    need: row.need ?? null,
    ...(row.valid === false ? explainNeed(row.need ?? '交接授权') : {}),
  }))
  return {
    state: '资料不合格',
    business: body?.business ?? null,
    reason: body?.原因 ?? null,
    items,
    missingFields: [...new Set(items.flatMap(row => row.need ? [row.need] : []))],
    evidence: items.flatMap(row => row.evidence ? [{ serial: row.serial, field: row.field, evidence: row.evidence, hint: row.hint }] : []),
    next: '回到交接记录补授权/补序列号或合同，再重新预检；不要复用这次票据',
  }
}

function receiptRows(receipt) {
  return receipt?.statements ?? []
}

/**
 * 判断一条回执是否属于“我们这次登记”。
 * 同一业务号下现场人员为替机自己补办的服务（owner 不同）不算。
 */
export function receiptMatches(statement, { business, serials, revision, owner, statuses = ['已确认'] }) {
  if (!statement) return false
  if (business && statement.business && statement.business !== business) return false
  if (serials?.length && !serials.includes(statement.serial)) return false
  if (revision !== undefined && revision !== null && statement.revision !== revision) return false
  if (owner && statement.owner && statement.owner !== owner) return false
  if (statuses && !statuses.includes(statement.status)) return false
  return true
}

export function findRegistration(receipt, { business, serials, revision, owner }) {
  return receiptRows(receipt).filter(row =>
    receiptMatches(row, { business, serials, revision, owner, statuses: ['已确认'] }))
}

export function findPriorStatements(receipt, { business, serials }) {
  return receiptRows(receipt).filter(row =>
    (!business || row.business === business) &&
    (!serials?.length || serials.includes(row.serial)))
}

/**
 * 门户已收到登记但客户端没拿到回执时，按业务标识和有效范围查明单据。
 * 不重提票据，也不把同一业务号下别人的签收当成自己的登记。
 */
export async function reconcileRegistration(client, {
  business, serials, revision, owner = null, attempts = 1, wait = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let receipt = null
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    receipt = await client.receipt(business)
    const confirmed = findRegistration(receipt, { business, serials, revision, owner })
    if (confirmed.length) {
      return {
        found: true,
        state: '已确认（由回执查明）',
        business,
        revision,
        receipts: confirmed,
        receiptId: confirmed[0].id,
        serials: confirmed.map(row => row.serial),
        others: findPriorStatements(receipt, { business, serials }).filter(row => !confirmed.includes(row)),
      }
    }
    if (attempt + 1 < attempts) await wait(100 * (attempt + 1))
  }
  return {
    found: false,
    state: '回执中尚无本次确认行',
    business,
    revision,
    receipts: [],
    serials: [],
    others: findPriorStatements(receipt, { business, serials }),
    next: '保留票据与业务号；等门户可查询后按同一范围再核对，不要重复登记',
  }
}

/**
 * 现场人员已经补交成功的内容：从回执按业务号 + 序列号确认，标出其经办人，
 * 不能冒用成设备代办的登记。
 */
export function confirmSupplement(receipt, { business, serials, owner = null }) {
  const rows = receiptRows(receipt).filter(row =>
    row.status === '已确认' &&
    (!business || row.business === business) &&
    (!serials?.length || serials.includes(row.serial)))
  return rows.map(row => ({
    receipt: row.id,
    business: row.business,
    revision: row.revision,
    serial: row.serial,
    contract: row.contract,
    owner: row.owner,
    signedByOther: Boolean(owner && row.owner && row.owner !== owner),
    note: owner && row.owner && row.owner !== owner
      ? `由 ${row.owner} 签收，按对方的签收处理，设备代办不代为更正`
      : '已确认',
  }))
}

/** 登记失败/不确定时的处置建议。 */
export function classifyRegistrationFailure(response, { business, serials } = {}) {
  const state = response.body?.state ?? null
  if (response.status === 409) {
    return {
      kind: 'revision-conflict',
      state: state ?? '修订冲突',
      currentRevision: response.body?.currentRevision ?? null,
      action: '交接记录已改版：重新读取 /handover，按新版本的序列范围重新预检；不要复用旧票据',
    }
  }
  if (response.status === 503) {
    return {
      kind: 'uncertain',
      state: state ?? '回执查询中',
      action: `门户可能已收到登记：按业务标识 ${business ?? ''} 查 /receipt，确认范围 ${serials?.join('、') ?? ''} 是否已有确认行；未查明前不重提`,
    }
  }
  if (response.status === 422 || response.status === 400) {
    return {
      kind: 'rejected',
      state: state ?? '资料不合格',
      action: '按门户返回的必填字段补齐证据后重新预检',
      missing: mapPrecheckFailure(response.body).evidence,
    }
  }
  if (response.status >= 500) {
    return { kind: 'source-error', state, action: '资料源暂时不可用；先查回执再决定是否重试' }
  }
  return { kind: 'unexpected', state, action: '门户返回未识别的结果，保留票据并人工核对' }
}

/**
 * 一次性完成预检 + 登记，并在不确定时回到回执核对。
 * 返回结构可直接作为现场登记清单。
 */
export async function submitRegistration(client, handover, contracts, {
  at = new Date(), requests = [], owner = '设备代办', reconcileAttempts = 2, wait = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const fullScope = registrationScope(handover, contracts, { at })
  // 只登记这次实际需要的序列范围；没有指定请求时才使用整批已授权范围。
  const wanted = requests.length ? new Set(requests.map(row => row.serial)) : null
  const scope = wanted
    ? { ...fullScope, entries: fullScope.entries.filter(entry => wanted.has(entry.serial)) }
    : fullScope
  const unnoticed = wanted
    ? [...wanted].filter(serial => !fullScope.entries.some(entry => entry.serial === serial))
    : []
  if (!scope.entries.length) {
    return {
      ok: false,
      phase: 'scope',
      state: unnoticed.length ? '请求的序列不在本次可登记范围' : '没有可登记的序列',
      scope,
      unnoticed: unnoticed.map(serial => ({
        serial,
        reason: [...fullScope.retained, ...fullScope.excluded].find(row => row.serial === serial)?.reason ?? '不在交接记录',
      })),
      missing: fullScope.retained
        .filter(row => wanted?.has(row.serial))
        .map(row => ({ serial: row.serial, ...explainNeed('交接授权') })),
      next: '核对交接记录的实际序列范围；未授权或留置原机的附件不能按替机登记',
    }
  }
  const body = buildPrecheckBody(handover, scope.entries, { requests })
  const check = await client.precheck(body)
  if (check.status !== 200) {
    return {
      ok: false,
      phase: 'precheck',
      state: check.body?.state ?? '预检未通过',
      status: check.status,
      body: check.body,
      failure: check.status === 422 ? mapPrecheckFailure(check.body) : classifyRegistrationFailure(check, { business: handover.ref, serials: body.items.map(i => i.serial) }),
      scope,
      precheckBody: body,
    }
  }
  const ticket = check.body?.ticket
  if (!ticket) {
    return { ok: false, phase: 'precheck', state: '预检未给出票据', body: check.body, scope }
  }
  const revision = check.body?.version ?? handover.version
  const registration = await client.register({ ticket, revision })

  if (registration.status === 200) {
    const receipt = await client.receipt(handover.ref)
    const confirmed = findRegistration(receipt, {
      business: handover.ref,
      serials: (registration.body?.scope ?? body.items.map(item => item.serial)),
      revision,
      owner: null,
    })
    return {
      ok: true,
      phase: 'registered',
      state: registration.body?.state ?? '已确认',
      ticket,
      revision,
      scope: registration.body?.scope ?? body.items.map(item => item.serial),
      receiptId: confirmed[0]?.id ?? null,
      receipts: confirmed,
      allStatements: findPriorStatements(receipt, { business: handover.ref, serials: body.items.map(item => item.serial) }),
      handoverVersion: handover.version,
      maintenanceList: maintenanceList(scope, contracts, at),
    }
  }

  const failure = classifyRegistrationFailure(registration, {
    business: handover.ref,
    serials: body.items.map(item => item.serial),
  })

  if (failure.kind === 'uncertain' || registration.status >= 500) {
    // 先查回执，查明就不重提。
    let receipt = null
    let confirmed = []
    for (let attempt = 0; attempt <= reconcileAttempts; attempt++) {
      receipt = await client.receipt(handover.ref)
      confirmed = findRegistration(receipt, {
        business: handover.ref,
        serials: (registration.body?.scope ?? body.items.map(item => item.serial)),
        revision,
        owner: null,
      })
      if (confirmed.length) break
      if (attempt < reconcileAttempts) await wait(100 * (attempt + 1))
    }
    if (confirmed.length) {
      return {
        ok: true,
        phase: 'reconciled',
        state: '已确认（由回执查明）',
        ticket,
        revision,
        registry: registration.body ?? null,
        scope: confirmed.map(row => row.serial),
        receiptId: confirmed[0].id,
        receipts: confirmed,
        allStatements: findPriorStatements(receipt, { business: handover.ref, serials: body.items.map(item => item.serial) }),
        handoverVersion: handover.version,
        maintenanceList: maintenanceList(scope, contracts, at),
        note: failure.action,
      }
    }
    return {
      ok: false,
      phase: 'unresolved',
      state: failure.state,
      status: registration.status,
      failure,
      body: registration.body,
      ticket,
      revision,
      scope,
      receipts: [],
      next: '回执里还没有确认行；保留票据和业务号，等门户可查询后再核对，不要重复登记',
    }
  }

  return {
    ok: false,
    phase: 'registration',
    state: failure.state,
    status: registration.status,
    failure,
    body: registration.body,
    ticket,
    revision,
    scope,
  }
}

/** 即将出具的维护清单：只列本次实际登记范围。 */
export function maintenanceList(scope, contracts, at = new Date()) {
  return scope.entries.map(entry => {
    const contract = contracts.find(row => row.contract === entry.contract)
    return {
      serial: entry.serial,
      role: entry.role,
      contract: entry.contract,
      pool: contract?.servicePool ?? null,
      services: contract?.sharedServices ?? [],
      note: entry.coverage?.reason ?? null,
      placement: entry.placement ?? null,
      approved: entry.row?.approved === true,
      retainedOnOriginal: entry.placement === 'original',
    }
  })
}

/**
 * 更正一条已登记记录。
 *
 * @param {object} options
 * @param {string} options.business
 * @param {string} options.replaces       原回执号
 * @param {number} options.receiptRevision 原回执版本
 * @param {Array}  options.items          本次需要登记的正确范围
 * @param {object} options.handover       本次交接记录（用来确认变更属于本次登记）
 * @param {string} [options.owner]        经办人；不是本人签收的不代为更正
 */
export async function correctRegistration(client, handover, contracts, {
  business, replaces, receiptRevision, items, owner = '设备代办', at = new Date(), reason = '',
} = {}) {
  if (!business || !replaces || !Number.isInteger(receiptRevision)) {
    return { ok: false, state: '缺少更正依据', reason: '必须给出业务号、原回执号与回执版本' }
  }
  const receipt = await client.receipt(business)
  const current = receiptRows(receipt).find(row => row.id === replaces)
  if (!current) {
    return { ok: false, state: '回执不存在', reason: `门户没有回执 ${replaces}` }
  }

  // 变更必须属于本次登记：原回执和这次要更正的序列号都要在本次交接范围里。
  // 先做这一层，避免把不相干的回执/序列号塞进更正。
  const scope = buildScope(handover, at)
  const allowed = new Set([...scope.loanerSerials, ...scope.originalSerials])
  if (!allowed.has(current.serial)) {
    return {
      ok: false,
      state: '不属于本次登记',
      reason: `回执 ${replaces} 的序列号 ${current.serial} 不在本次交接范围（${[...allowed].join('、')}）`,
      current,
    }
  }
  const correctedSerials = (items ?? []).map(row => row.serial)
  const stray = correctedSerials.filter(serial => !allowed.has(serial))
  if (stray.length) {
    return {
      ok: false,
      state: '不属于本次登记',
      reason: `更正请求包含不在本次交接范围的序列号：${stray.join('、')}`,
      current,
    }
  }
  if (!correctedSerials.length) {
    return { ok: false, state: '缺少更正范围', reason: '更正必须给出需要登记的正确序列范围', current }
  }

  if (current.status !== '已确认') {
    // 门户可能已经把这笔更正做完了：同一回执、同一版本、同一序列号已经是撤回/更正
    // 后的状态。此时重提只会制造第二张单据，按“已生效”回报。
    const withdrawn = ['撤回确认', '已撤回', '已取消', 'withdrawn', 'cancelled'].includes(current.status)
    if (withdrawn && current.revision === receiptRevision && correctedSerials.includes(current.serial)) {
      return {
        ok: true,
        phase: 'already-applied',
        state: '已生效（无需重复更正）',
        replaces,
        receiptRevision,
        scope: [current.serial],
        receipts: [current],
        current,
        note: `回执 ${replaces} 已是 ${current.status}，变更已属于本次登记，不重复提交替代票据`,
      }
    }
    return {
      ok: false,
      state: '回执不可更正',
      reason: `回执 ${replaces} 当前状态为 ${current.status}，不是有效确认`,
      current,
    }
  }
  if (current.revision !== receiptRevision) {
    return {
      ok: false,
      state: '回执版本不符',
      reason: `回执 ${replaces} 已从版本 ${receiptRevision} 变为 ${current.revision}，不能按旧版本更正`,
      current,
    }
  }
  if (current.owner && current.owner !== owner) {
    return {
      ok: false,
      state: '回执已被其他经办人签收',
      reason: `回执 ${replaces} 属于 ${current.owner}；同一业务号下现场人员自己的服务按它自己的签收处理`,
      current,
    }
  }
  const check = await client.precheck({
    business,
    revision: handover.version,
    items: items.map(row => ({
      serial: row.serial,
      contract: row.contract,
      action: row.action ?? reason ?? '更正登记',
    })),
  })
  if (check.status !== 200) {
    return {
      ok: false,
      state: check.body?.state ?? '更正预检未通过',
      status: check.status,
      failure: check.status === 422 ? mapPrecheckFailure(check.body) : null,
      body: check.body,
    }
  }
  const registration = await client.register({
    ticket: check.body.ticket,
    revision: check.body.version ?? handover.version,
    replaces,
    receiptRevision,
  })
  if (registration.status === 200) {
    const after = await client.receipt(business)
    const confirmed = after.statements?.filter(row =>
      correctedSerials.includes(row.serial) && row.status === '已确认' && row.revision !== current.revision) ?? []
    return {
      ok: true,
      state: registration.body?.state ?? '已更正',
      ticket: check.body.ticket,
      revision: check.body.version ?? handover.version,
      replaces,
      receiptRevision,
      scope: registration.body?.scope ?? correctedSerials,
      receipts: confirmed,
      allStatements: after.statements ?? [],
    }
  }
  return {
    ok: false,
    state: registration.body?.state ?? '更正未完成',
    status: registration.status,
    failure: classifyRegistrationFailure(registration, { business, serials: correctedSerials }),
    body: registration.body,
  }
}

/** 事后解释：某条维修工单为什么留在旧设备。 */
export function explainOrderRetention(order, handover, contracts, at = new Date()) {
  if (!order) return { order: null, reason: '没有这条工单' }
  const placement = order.serial === handover?.original
    ? 'original'
    : placementOf(handover, order.serial)
  const covered = contracts
    .map(contract => ({ contract: contract.contract, ...contractCoverage(contract, order.serial, handover, at) }))
  const contract = covered.find(row => row.covered) ?? null
  const row = itemBySerial(handover, order.serial)
  let reason
  if (placement === 'original') {
    if (order.serial !== handover?.original) {
      reason = row?.approved === true && row.to === row.from
        ? `附件 ${order.serial} 的交接行是留置原机，工单继续挂在原机 ${handover.original}`
        : `附件 ${order.serial} 没有获得随替机调出的交接授权，工单继续挂在原机 ${handover.original}`
    } else {
      reason = `工单属于原机 ${order.serial}；${handover?.state ?? '原机状态未说明'}，停用不等于已归还，原机合同内的续修仍由原机承担`
    }
  } else if (placement === 'loaner') {
    reason = `序列号 ${order.serial} 已授权随替机 ${handover.loaner}，可按替机登记`
  } else if (placement === 'elsewhere') {
    reason = `序列号 ${order.serial} 已授权调往其他科室，不在本次替机范围`
  } else {
    reason = `交接记录没有 ${order.serial} 的落点，需人工核对`
  }
  return {
    order: order.id ?? null,
    serial: order.serial,
    host: order.host ?? null,
    status: order.status ?? null,
    placement,
    contract: contract?.contract ?? null,
    contractReason: contract?.reason ?? covered[0]?.reason ?? null,
    reason,
    handoverVersion: handover?.version ?? null,
    evidence: '/handover',
  }
}

/** 科室视角：只显示已确认适用的部分 + 待人工接手 + 具名占用。 */
export function availableServices({ handover, contracts, receipts, capacity, at = new Date() }) {
  const scope = registrationScope(handover, contracts, { at })
  const confirmedRows = (receipts?.statements ?? []).filter(row => row.status === '已确认')
  const confirmed = scope.entries.map(entry => {
    const receipt = confirmedRows.find(row => row.serial === entry.serial && row.contract === entry.contract)
    return {
      serial: entry.serial,
      role: entry.role,
      contract: entry.contract,
      confirmed: Boolean(receipt),
      receipt: receipt?.id ?? null,
      receiptOwner: receipt?.owner ?? null,
      services: contracts.find(row => row.contract === entry.contract)?.sharedServices ?? [],
    }
  }).filter(entry => entry.confirmed)
  return {
    confirmed,
    // 停用不等于已归还：停用中的原机也要作为“待人工接手”列出，不能只列附件。
    pendingManual: [
      ...(scope.window.originalStopped
        ? [{
            serial: handover.original,
            role: '主机',
            placement: 'original',
            reason: `${handover.state}；停用不等于已归还，仍待人工接手`,
          }]
        : []),
      ...scope.pendingManual,
    ],
    excluded: scope.excluded,
    occupancies: (capacity?.reservations ?? [])
      .filter(row => ['confirmed', 'pending', '使用中'].includes(row.status))
      .map(row => ({
        reservation: row.id,
        serial: row.serial,
        contract: row.contract,
        pool: row.pool,
        owner: row.owner,
        from: row.from,
        to: row.to,
        status: row.status,
        label: `${row.id}（${row.serial}，${row.owner ?? '未具名'}，${row.status}）`,
      })),
    note: '只列已确认适用的服务；未确认的附件与仍待人工接手的设备不在可用范围。',
  }
}
