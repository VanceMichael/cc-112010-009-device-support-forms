# 设备交接与厂商登记

医院和厂商均为合成行政数据。服务合同适用范围按主机及其具名附件列出，不包含临床信息。

使用 Node.js 22.23.4。执行 `npm ci` 后运行 `npm start`，资料源默认监听本机 4173 端口，可用 `PORT` 指定端口。

`GET /handover` 和 `GET /service` 是可浏览的资料入口。`GET /ready` 返回当前发布序号和总发布次数。`PUT /replay` 接受 JSON `{"step":1}`，用于在联调时将来源切到指定发布时刻。发布序号从 0 开始。每次发布只列变化的来源，应答沿用上一轮存在且未被替换的地址。收到 404 并不代表之前的历史资料从业务上被撤回。重新启动服务从第 0 次发布开始。

/handover 由设备员登记，from 为原科室，loanUntil 为空表示归还时间待定。附件可单独留置，授权的操作见 approved。/service 展示合约及附件许可，工单列表中的 serial 指送修对象。POST /precheck 接收 business、revision、items，每行提供 serial、contract、action。POST /registration 使用预检给出的同版本票据。/receipt 按业务标识查询门户当前确认行及所有人。 更正已登记记录时提交替代票据，并指定 replaces（原回执号）与 receiptRevision（原回执版本）；门户会拒绝已被其他经办人修改的回执。

厂商 /visit-capacity 公布每项服务各自的名额池。confirmed 是尚在使用的现场预约，completed 是收到完结回条后的事实。厂商的名额占用按 pool，而不是按主机型号。

运行 `npm test` 可校验资料源实际应答。样本内容存放在 `samples/`，开发时通过各来源的本地地址进行联调。
