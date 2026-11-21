# 设备交接与厂商登记

医院和厂商均为合成行政数据。服务合同适用范围按主机及其具名附件列出，不包含临床信息。

使用 Node.js 22.23.4。执行 `npm ci` 后运行 `npm start`，资料源默认监听本机 4173 端口，可用 `PORT` 指定端口。

`GET /handover` 和 `GET /service` 是可浏览的资料入口。`GET /ready` 或 `GET /health` 返回当前发布序号和总发布次数。`PUT /replay` 接受 JSON `{"step":1}`，用于在联调时将来源切到指定发布时刻。发布序号从 0 开始。每次发布只列变化的来源，应答沿用上一轮存在且未被替换的地址。收到 404 并不代表之前的历史资料从业务上被撤回。重新启动服务从第 0 次发布开始。

/handover 由设备员登记，from 为原科室，loanUntil 为空表示归还时间待定。附件可单独留置，授权的操作见 approved。/service 展示合约及附件许可，工单列表中的 serial 指送修对象。POST /precheck 接收 business、revision、items，每行提供 serial、contract、action。POST /registration 使用预检给出的同版本票据。/receipt 按业务标识查询门户当前确认行及所有人。 更正已登记记录时提交替代票据，并指定 replaces（原回执号）与 receiptRevision（原回执版本）；门户会拒绝已被其他经办人修改的回执。

厂商 /visit-capacity 公布每项服务各自的名额池。confirmed 是尚在使用的现场预约，completed 是收到完结回条后的事实。厂商的名额占用按 pool，而不是按主机型号。

运行 `npm test` 可校验资料源实际应答。样本内容存放在 `samples/`，开发时通过各来源的本地地址进行联调。

## 登记工具

`npm run collect -- --source http://127.0.0.1:4173` 读取交接记录、服务目录与工单，输出本次实际需要登记的序列范围。只读命令不需要额外参数。

常用命令（均接受 `--source`、`--at <ISO 时刻>`、`--business <业务号>`、`--owner <经办人>`）：

| 命令 | 作用 |
| --- | --- |
| `--scope` | 本次要登记的替机与已授权附件；单独列出仍由原机承担的条目及原因 |
| `--report` | 科室视角：已确认适用、待人工接手、具名预约占用 |
| `--explain E-5` | 解释某条工单为什么留在原机 |
| `--plan --request P-40:S-5:临借上门` | 只按 pool 计算名额：新名额 / 搭已有预约 / 阻塞 |
| `--register --request …` | 预检 + 登记；回执查不到时按业务号核对，不重提票据 |
| `--correct RR-17:1 --request P-40:S-5:撤回临借` | 提交替代票据更正；要求同版本、本人签收且属于本次登记 |
| `--release Z-12:P-40:S-5:上门 --request …` | 收到完结回条后释放占用，再按当时有效的交接授权判断能否登记 |

模块划分：

- `lib/handover.mjs`：交接行授权、附件落点、合同覆盖与临借共享窗口；
- `lib/capacity.mjs`：pool 占用、预约共享、撤回保护与完结释放；
- `lib/registration.mjs`：范围推导、预检/登记/回执核对/更正、科室视角与工单归因；
- `lib/source-client.mjs`：带超时与缓存失效的资料源客户端；
- `lib/dates.mjs`：纯日期按 +08:00 业务日解释。

几条不会自动放宽的判断：未授权或留置原机的附件不进入替机登记；停用的原机仍算未归还；预检合格不等于有空名额；替机临时 pool 的名额不能算成原机 pool 的新名额；别人签收的回执不代为更正。
