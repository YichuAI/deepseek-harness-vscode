/**
 * protocol-probe.ts — ask a live `dsh web` what it actually serves.
 *
 * The plugin used to hardcode wire names that no local artifact agreed with,
 * which is how v0.0.4 ended up speaking a protocol its own host did not have.
 * This script replaces guessing with measurement: it negotiates the wire shape,
 * then walks a candidate method list and reports which endpoints exist.
 *
 * Run:  npx tsx scripts/protocol-probe.ts [host] [port]
 *        (defaults to 127.0.0.1:3080, i.e. the default `dsh web` port)
 *
 * Exit code 0 always — the output is a report, not a gate.
 */

import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { httpRequest } from '../src/harness/http.ts'
import { negotiateWire, wireEndpoint, type WireProfile } from '../src/harness/wire.ts'

/** Methods worth asking about, written canonically as `ns/method`. */
const CANDIDATES: ReadonlyArray<{ method: string; note: string }> = [
  { method: 'session/list', note: '会话列表' },
  { method: 'session/create', note: '新建会话' },
  { method: 'session/cancel', note: '取消当前轮次' },
  { method: 'session/prompt', note: '发送消息' },
  { method: 'session/history', note: '历史分页（旧）' },
  { method: 'session/fork', note: '会话分叉' },
  { method: 'session/rename', note: '会话重命名' },
  { method: 'session/search', note: '全文搜索会话' },
  { method: 'session/models', note: '模型目录（旧名）' },
  { method: 'session/modelCatalog', note: '模型目录（新名）' },
  { method: 'session/selectModel', note: '切换模型' },
  { method: 'session/updateQueue', note: '排队/转向消息' },
  { method: 'session/attachment', note: '附件上传' },
  { method: 'workspace/list', note: '工作区列表' },
  { method: 'workspace/create', note: '注册工作区' },
  { method: 'workspace/archiveSession', note: '归档会话' },
  { method: 'host/describe', note: '宿主身份（已删除？）' },
  { method: 'host/listDirectory', note: '目录浏览' },
  { method: 'agentPreset/list', note: 'Agent 预设列表' },
  { method: 'agentPreset/select', note: '切换 Agent 预设' },
  { method: 'goal/create', note: '创建目标' },
  { method: 'goal/list', note: '目标列表' },
  { method: 'subagent/list', note: '子代理列表' },
  { method: 'llm/models', note: 'LLM 模型发现' },
  { method: 'llm/providers', note: 'LLM 供应商' },
  { method: 'settings/describe', note: '设置面板' },
  { method: 'credentials/describe', note: '凭据面板' },
  { method: 'skill/list', note: '技能列表' },
  { method: 'commands/list', note: 'slash 命令' },
]

type Verdict = 'ok' | 'rejected' | 'missing'

interface Row {
  endpoint: string
  verdict: Verdict
  note: string
  detail: string
}

async function probe(
  host: string,
  port: number,
  profile: WireProfile,
  cookie: string | undefined,
  method: string,
  note: string,
): Promise<Row> {
  const endpoint = wireEndpoint(profile.endpointStyle, method)
  let res
  try {
    res = await httpRequest({
      host,
      port,
      method: 'POST',
      path: `/api/${endpoint}`,
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        origin: `http://${host}:${String(port)}`,
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: endpoint, payload: { args: {} } }),
      timeoutMs: 3_000,
    })
  } catch (e) {
    return { endpoint, verdict: 'missing', note, detail: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 404) return { endpoint, verdict: 'missing', note, detail: '404' }
  if (res.status === 401) return { endpoint, verdict: 'rejected', note, detail: '401 — 需要会话 cookie' }
  // Any structured envelope means the endpoint exists; the args almost certainly
  // do not match its descriptor, which is fine — existence is what we measure.
  try {
    const env = JSON.parse(res.body) as { result?: { ok?: boolean; error?: { code?: string } } }
    if (env.result?.ok === true) return { endpoint, verdict: 'ok', note, detail: 'ok' }
    return { endpoint, verdict: 'ok', note, detail: env.result?.error?.code ?? `HTTP ${String(res.status)}` }
  } catch {
    return { endpoint, verdict: 'ok', note, detail: `HTTP ${String(res.status)} (non-JSON)` }
  }
}

async function main(): Promise<void> {
  const host = process.argv[2] ?? '127.0.0.1'
  const port = Number(process.argv[3] ?? '3080')
  console.log(`\nprobing dsh web at ${host}:${String(port)}\n`)

  let stored: string | undefined
  const auth = new BrowserSessionAuth({
    host,
    port,
    store: { load: async () => stored, save: async (v) => { stored = v } },
    log: () => {},
    allowLocalMint: true,
  })
  await auth.init()
  if (!auth.isReady()) await auth.tryMintLocalSession()
  const cookie = auth.cookieHeader()
  console.log(`session cookie: ${cookie === undefined ? 'none' : 'present'}`)

  const negotiation = await negotiateWire({ host, port, cookie: () => cookie, log: () => {} })
  if (negotiation.kind !== 'ok') {
    console.log(`\nnegotiation failed: ${negotiation.kind}`)
    if (negotiation.kind === 'unreachable') console.log(`  ${negotiation.message}`)
    if (negotiation.kind === 'auth-required') {
      console.log('  每次 /api/* 都返回 401：宿主要求浏览器会话 cookie。')
      console.log('  启动 dsh web 后，把打印出的那行 URL 用插件命令 "Set Session Token from Launch URL" 粘进去。')
    }
    return
  }

  const profile = negotiation.profile
  console.log(`endpoint style : ${profile.endpointStyle}`)
  console.log(`event socket   : ${profile.muxPath}`)
  console.log(`authentication : ${profile.auth}`)
  console.log(`session/list   : args ${JSON.stringify(profile.listArgs)}`)
  if (profile.catalogEndpoint !== undefined) console.log(`model catalog  : ${profile.catalogEndpoint}`)

  const rows: Row[] = []
  for (const candidate of CANDIDATES) {
    rows.push(await probe(host, port, profile, cookie, candidate.method, candidate.note))
  }

  console.log('\nendpoint                    状态        说明')
  console.log('─'.repeat(78))
  for (const row of rows) {
    const mark = row.verdict === 'ok' ? '✓ 存在' : row.verdict === 'rejected' ? '✗ 401 ' : '· 无  '
    console.log(`${row.endpoint.padEnd(28)}${mark}  ${row.note.padEnd(22)}${row.detail}`)
  }

  const available = rows.filter(r => r.verdict === 'ok').length
  console.log(`\n${String(available)}/${String(rows.length)} 个端点存在。\n`)
}

main().catch((e) => {
  console.error('\nprobe error:', e)
  process.exit(1)
})
