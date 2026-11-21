#!/usr/bin/env node
/**
 * 设备交接与厂商登记工具（命令行）。
 *
 * 用法：
 *   node bin/collect.mjs --source http://127.0.0.1:4173 [--at 2026-11-25T10:00:00+08:00]
 *   node bin/collect.mjs --source ... --report          输出科室可用服务摘要
 *   node bin/collect.mjs --source ... --scope           输出本次实际序列范围与排除原因
 *   node bin/collect.mjs --source ... --explain E-5     解释某工单为何留在旧设备
 *   node bin/collect.mjs --source ... --register --request P-42:S-5:临借上门
 *   node bin/collect.mjs --source ... --correct RR-17:1 P-40:S-5:撤回临借
 *   node bin/collect.mjs --source ... --release Z-12:P-40:S-5:上门
 *
 * 只做读取时不需要任何参数；提交类命令会把结果打印成 JSON，便于现场核对。
 */

import { parseArgs } from 'node:util'
import { makeSourceClient } from '../lib/source-client.mjs'
import { summarizeHandover } from '../lib/handover.mjs'
import {
  availableServices, correctRegistration, explainOrderRetention, registrationScope, submitRegistration,
} from '../lib/registration.mjs'
import { applyCompletion, capacitySnapshot, planVisits } from '../lib/capacity.mjs'

function usage() {
  return `设备交接与厂商登记工具

  --source <url>          资料源地址（默认 http://127.0.0.1:4173）
  --at <iso>              以某时刻判断临借窗口/合同有效期
  --business <id>         业务号（默认取交接记录的 ref）
  --owner <name>          经办人（默认 设备代办）
  --scope                 输出本次实际需要登记的序列范围
  --report                输出科室可用服务摘要
  --explain <order-id>    解释某条工单为何留在旧设备
  --register              预检 + 登记，并在回执不确定时核对
  --request <s:c:a>       登记请求，s=serial, c=contract, a=action（可重复）
  --plan                  只看名额占用，不提交
  --correct <id:rev>      更正回执：id=原回执号, rev=原回执版本
  --release <id:s:c:svc>  收到完结回条：id=回执号, s=serial, c=contract, svc=服务项
  --help                  显示本说明`
}

function splitRequest(value) {
  const [serial, contract, action] = value.split(':')
  if (!serial) throw new Error('--request 需要 serial:contract:action')
  return { serial, contract: contract || undefined, action: action || '临借上门' }
}

function splitReceipt(value) {
  const [id, serial, contract, service] = value.split(':')
  if (!id) throw new Error('--release 需要 id:serial:contract:service')
  return { id, serial, contract, service }
}

async function main() {
  const options = parseArgs({
    options: {
      source: { type: 'string', default: 'http://127.0.0.1:4173' },
      at: { type: 'string' },
      business: { type: 'string' },
      owner: { type: 'string', default: '设备代办' },
      scope: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      explain: { type: 'string' },
      register: { type: 'boolean', default: false },
      request: { type: 'string', multiple: true, default: [] },
      plan: { type: 'boolean', default: false },
      correct: { type: 'string' },
      release: { type: 'string' },
      help: { type: 'boolean', default: false, short: 'h' },
    },
    allowPositionals: false,
  }).values

  if (options.help) {
    console.log(usage())
    return
  }

  const at = options.at ? new Date(options.at) : new Date()
  const client = makeSourceClient(options.source)
  const handover = await client.handover()
  const contracts = await client.service()
  const business = options.business ?? handover.ref
  const requests = options.request.map(splitRequest)
  const print = value => console.log(JSON.stringify(value, null, 2))

  if (options.explain) {
    const orders = await client.orders()
    const order = orders.find(row => row.id === options.explain)
    print(explainOrderRetention(order, handover, contracts, at))
    return
  }

  if (options.scope) {
    print(registrationScope(handover, contracts, { at }))
    return
  }

  if (options.report) {
    const receipt = await client.receipt(business)
    const capacity = await client.capacity()
    const scope = registrationScope(handover, contracts, { at })
    const report = availableServices({
      handover, contracts, receipts: receipt, capacity, at,
    })
    print({
      business,
      handoverVersion: handover.version,
      window: scope.window,
      ...report,
      capacity: capacitySnapshot(capacity),
      available: report.confirmed,
    })
    return
  }

  if (options.plan) {
    const capacity = await client.capacity()
    print(planVisits({ capacity, contracts, handover, requests, at }))
    return
  }

  if (options.correct) {
    const [replaces, revision] = options.correct.split(':')
    const items = requests.map(row => ({
      serial: row.serial,
      contract: row.contract ?? null,
      action: row.action,
    }))
    print(await correctRegistration(client, handover, contracts, {
      business, replaces, receiptRevision: Number(revision), items, owner: options.owner, at,
    }))
    return
  }

  if (options.release) {
    const receipt = splitReceipt(options.release)
    const capacity = await client.capacity()
    const result = applyCompletion({
      capacity, receipt, contracts, handover,
      requests: requests.length ? requests : [{ serial: handover.loaner, action: '临借上门' }],
      at,
    })
    print({ ...result, before: capacitySnapshot(capacity), after: capacitySnapshot(result.capacity) })
    return
  }

  if (options.register) {
    print(await submitRegistration(client, handover, contracts, {
      at, requests, owner: options.owner,
    }))
    return
  }

  print({
    business,
    handover: summarizeHandover(handover, at),
    contracts: contracts.map(contract => ({
      contract: contract.contract,
      serial: contract.serial,
      parts: contract.parts,
      pool: contract.servicePool,
      sharedServices: contract.sharedServices,
      sharedUntil: contract.sharedUntil,
    })),
    scope: registrationScope(handover, contracts, { at }),
    orders: await client.orders(),
  })
}

main().catch(error => {
  console.error(JSON.stringify({ state: '执行失败', error: error.message, status: error.status ?? null }, null, 2))
  process.exitCode = 1
})
