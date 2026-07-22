/**
 * jmcomic AI 工作流 — MCP：车牌下载 / 开盲盒
 *
 * 有会话：子服 API → 车牌插件交付；e._sentMsgIds 切片后两分钟一并撤回。
 */
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js'
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { scheduleMsgRecall } from '#utils/msg-recall.js'
import { ChepaiPlugin } from '../plugin/车牌.js'

const DOWNLOAD_TIMEOUT_MS = 600_000
const RECALL_DELAY_MS = 120_000
const RECALL_TAG = '车牌撤回'

function digitsOnly(raw) {
  const s = String(raw ?? '').trim()
  return /^\d+$/.test(s) ? s : null
}

function recallFrom(e) {
  return (e._sentMsgIds ||= []).length
}

function scheduleSince(e, from) {
  return scheduleMsgRecall(e, e._sentMsgIds.slice(from), {
    delayMs: RECALL_DELAY_MS,
    logTag: RECALL_TAG,
  })
}

export default class JmcomicStream extends AiWorkflow {
  constructor() {
    super({
      name: 'jmcomic',
      description: '禁漫本子：车牌下载（传数字）、开盲盒（可选 tag）',
      version: '1.3.1',
      author: 'XRK',
      priority: 88,
      capabilities: ['tools', 'prompt'],
      frameworkToolSurface: true,
      config: { enabled: true, temperature: 0.2, maxTokens: 2000 },
      embedding: { enabled: false },
    })
  }

  buildSystemPrompt() {
    return [
      '禁漫本子（jmcomic）：',
      '- jmcomic.jm_download：车牌号纯数字，参数 album_id。',
      '- jmcomic.jm_blind_box：开盲盒。可选 tag（多标签空格分隔）。',
      '  tag：「全彩 中文」→ AND；「+A +B -C」→ 显式包含/排除；勿传纯数字。',
      '工具成功即已下载；有 QQ 会话时 PDF 已发送。据 album_id/title/tag_query 告知结果。',
    ].join('\n')
  }

  async init() {
    await super.init()
    this.registerJmTools()
  }

  registerJmTools() {
    this.registerMCPTool('jm_download', {
      description: '按禁漫车牌号下载本子 PDF。album_id 为纯数字，例如 472537。',
      inputSchema: {
        type: 'object',
        properties: { album_id: { type: 'string', description: '本子车牌号（纯数字）' } },
        required: ['album_id'],
      },
      handler: async (args = {}) => {
        const albumId = digitsOnly(args.album_id ?? args.id)
        if (!albumId) return this.errorResponse('INVALID_PARAM', 'album_id 必须为纯数字')
        return this._runDownload(albumId)
      },
      enabled: true,
    })

    this.registerMCPTool('jm_blind_box', {
      description: '开盲盒：随机抽 1 本。tag 可多标签空格分隔或 +A +B -C。',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: '可选。非纯数字。例：「全彩 中文」或「+全彩 +中文 -CG」。',
          },
        },
        required: [],
      },
      handler: async (args = {}) => {
        const tag = String(args.tag ?? args.tags ?? '').trim()
        if (tag && /^\d+$/.test(tag)) {
          return this.errorResponse('INVALID_PARAM', 'tag 不能为纯数字；例：全彩 中文')
        }
        return this._runBlindBox(tag)
      },
      enabled: true,
    })
  }

  _sessionEvent() {
    return getWorkflowRequestContext()?.e || null
  }

  async _replyQuote(e, msg) {
    if (e?.reply) await e.reply(msg, true)
  }

  async _deliverToSession(e, result, tag = '[车牌]') {
    const plugin = new ChepaiPlugin()
    plugin.e = e
    RuntimeUtil.makeLog('info', `${tag} AI 会话交付 album=${result.album_id}`, 'JmcomicStream')
    return plugin._deliverOneResult(result)
  }

  async _callDownloadApi(albumId) {
    const result = await AgentRuntime.callSubserver('/api/jmcomic/download', {
      body: { album_id: albumId },
      timeout: DOWNLOAD_TIMEOUT_MS,
      runtime: 'pyserver',
    })
    if (!result?.ok) throw new Error(result?.error || result?.reason || '下载失败')
    return result
  }

  async _callBlindBoxApi(tag = '') {
    const result = await AgentRuntime.callSubserver('/api/jmcomic/blind-box', {
      body: tag ? { tag } : {},
      timeout: DOWNLOAD_TIMEOUT_MS,
      runtime: 'pyserver',
    })
    if (!result?.ok) throw new Error(result?.error || result?.reason || '开盲盒失败')
    return result
  }

  _meta(result) {
    return {
      album_id: result.album_id,
      title: result.title,
      pdf_path: result.pdf_path,
      file_url: result.file_url,
      cached: result.cached,
      size: result.size,
      pick_source: result.pick_source,
      tag: result.tag,
      tag_query: result.tag_query,
    }
  }

  async _runDownload(albumId) {
    const e = this._sessionEvent()
    const from = e ? recallFrom(e) : 0
    try {
      await this._replyQuote(e, `正在下载车牌 ${albumId}…`)
      const result = await this._callDownloadApi(albumId)
      if (e) await this._deliverToSession(e, result, '[车牌]')
      if (e) scheduleSince(e, from)
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[车牌] API 失败: ${hint}`, 'JmcomicStream')
      try { await this._replyQuote(e, hint) } catch { /* ignore */ }
      if (e) scheduleSince(e, from)
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }

  async _runBlindBox(tag = '') {
    const e = this._sessionEvent()
    const from = e ? recallFrom(e) : 0
    try {
      await this._replyQuote(e, tag ? `开盲盒（tag:${tag}）中，抽号并下载…` : '开盲盒中，抽号并下载…')
      RuntimeUtil.makeLog('info', `[盲盒] 开始抽号${tag ? ` tag=${tag}` : ''}`, 'JmcomicStream')
      const result = await this._callBlindBoxApi(tag)
      RuntimeUtil.makeLog(
        'info',
        `[盲盒] 抽到 album=${result.album_id} source=${result.pick_source || ''} title=${result.title || ''}`,
        'JmcomicStream'
      )
      if (e) {
        const tagHint = result.tag_query || result.tag ? `（${result.tag_query || result.tag}）` : ''
        await this._replyQuote(e, `抽到车牌：${result.album_id}${tagHint}`)
        await this._deliverToSession(e, result, '[盲盒]')
      }
      if (e) scheduleSince(e, from)
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        source: 'blind_box',
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[盲盒] 失败: ${hint}`, 'JmcomicStream')
      try { await this._replyQuote(e, hint) } catch { /* ignore */ }
      if (e) scheduleSince(e, from)
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }
}
