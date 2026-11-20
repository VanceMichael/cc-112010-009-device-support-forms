import { makeSource } from './source.mjs'

const port = Number(process.env.PORT ?? 4173)
const source = makeSource()
source.listen(port, '127.0.0.1', () => console.log('资料源已启动 http://127.0.0.1:' + source.address().port))
