/**
 * jmcomic AI 工作流 — MCP：车牌下载 / 开盲盒
 *
 * 有会话 e：调子服 API → 车牌插件交付；文字/链接/PDF 收集 id 后统一两分钟撤回。
 * 无会话：只返回下载元数据。
 */
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js'
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { extractMsgIds, scheduleMsgRecall } from '#utils/msg-recall.js'
import { ChepaiPlugin } from '../plugin/车牌.js'

const DOWNLOAD_TIMEOUT_MS = 600_000
const RECALL_DELAY_MS = 120_000
const RECALL_TAG = '车牌撤回'

function digitsOnly(raw) {
  const s = String(raw ?? '').trim()
  return /^\d+$/.test(s) ? s : null
}

function scheduleAll(e, msgIds) {
  return scheduleMsgRecall(e, msgIds, { delayMs: RECALL_DELAY_MS, logTag: RECALL_TAG })
}

export default class JmcomicStream extends AiWorkflow {
  constructor() {
    super({
      name: 'jmcomic',
      description: '禁漫本子：车牌下载（传数字）、开盲盒（可选 tag）',
      version: '1.3.0',
      author: 'XRK',
      priority: 88,
      capabilities: ['tools', 'prompt'],
      frameworkToolSurface: true,
      config: {
        enabled: true,
        temperature: 0.2,
        maxTokens: 2000,
      },
      embedding: { enabled: false },
    })
  }

  buildSystemPrompt() {
    return [
      '禁漫本子（jmcomic）：',
      '- jmcomic.jm_download：车牌号纯数字，参数 album_id。',
      '- jmcomic.jm_blind_box：开盲盒。可选 tag（多标签空格分隔）。',
      '  tag 格式：',
      '  · 「全彩 中文」→ 同时含两标签（内部转 +全彩 +中文）',
      '  · 「+单行本 +中文 -CG」→ 显式包含/排除',
      '  · 不要传纯数字；用户说「开盲盒 全彩 中文」时把「全彩 中文」整段传入 tag。',
      '工具成功返回表示已下载；有 QQ 会话时 PDF 已发送。据 album_id/title/tag_query 告知结果，勿再说正在下载。',
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
        properties: {
          album_id: {
            type: 'string',
            description: '本子车牌号（纯数字）',
          },
        },
        required: ['album_id'],
      },
      handler: async (args = {}) => {
        const albumId = digitsOnly(args.album_id ?? args.id)
        if (!albumId) {
          return this.errorResponse('INVALID_PARAM', 'album_id 必须为纯数字')
        }
        return this._runDownload(albumId)
      },
      enabled: true,
    })

    this.registerMCPTool('jm_blind_box', {
      description:
        '开盲盒：随机抽 1 本并下载。tag 支持多标签空格分隔（全彩 中文 → AND）；也可用 +A +B -C。不传则用配置或日榜。',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description:
              '可选。禁漫标签查询，非纯数字。多标签空格分隔：' +
              '「全彩 中文」或「+全彩 +中文 -CG」。原样传给子服，由 search_tag + 标签列表校验。',
          },
        },
        required: [],
      },
      handler: async (args = {}) => {
        const tag = String(args.tag ?? args.tags ?? '').trim()
        if (tag && /^\d+$/.test(tag)) {
          return this.errorResponse(
            'INVALID_PARAM',
            'tag 不能为纯数字；多标签请空格分隔，例：全彩 中文'
          )
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
    if (!e?.reply) return []
    const res = await e.reply(msg, true)
    return extractMsgIds(res)
  }

  /** @returns {Promise<Array<string|number>>} */
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
    if (!result?.ok) {
      throw new Error(result?.error || result?.reason || '下载失败')
    }
    return result
  }

  async _callBlindBoxApi(tag = '') {
    const body = tag ? { tag } : {}
    const result = await AgentRuntime.callSubserver('/api/jmcomic/blind-box', {
      body,
      timeout: DOWNLOAD_TIMEOUT_MS,
      runtime: 'pyserver',
    })
    if (!result?.ok) {
      throw new Error(result?.error || result?.reason || '开盲盒失败')
    }
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
    const ids = []
    try {
      ids.push(...(await this._replyQuote(e, `正在下载车牌 ${albumId}…`)))
      const result = await this._callDownloadApi(albumId)
      if (e) ids.push(...(await this._deliverToSession(e, result, '[车牌]')))
      scheduleAll(e, ids)
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[车牌] API 失败: ${hint}`, 'JmcomicStream')
      try {
        ids.push(...(await this._replyQuote(e, hint)))
      } catch { /* ignore */ }
      scheduleAll(e, ids)
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }

  async _runBlindBox(tag = '') {
    const e = this._sessionEvent()
    const ids = []
    try {
      const tip = tag ? `开盲盒（tag:${tag}）中，抽号并下载…` : '开盲盒中，抽号并下载…'
      ids.push(...(await this._replyQuote(e, tip)))
      RuntimeUtil.makeLog('info', `[盲盒] 开始抽号${tag ? ` tag=${tag}` : ''}`, 'JmcomicStream')
      const result = await this._callBlindBoxApi(tag)
      RuntimeUtil.makeLog(
        'info',
        `[盲盒] 抽到 album=${result.album_id} source=${result.pick_source || ''} title=${result.title || ''}`,
        'JmcomicStream'
      )
      if (e) {
        const tagHint = result.tag_query || result.tag ? `（${result.tag_query || result.tag}）` : ''
        ids.push(...(await this._replyQuote(e, `抽到车牌：${result.album_id}${tagHint}`)))
        ids.push(...(await this._deliverToSession(e, result, '[盲盒]')))
      }
      scheduleAll(e, ids)
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        source: 'blind_box',
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[盲盒] 失败: ${hint}`, 'JmcomicStream')
      try {
        ids.push(...(await this._replyQuote(e, hint)))
      } catch { /* ignore */ }
      scheduleAll(e, ids)
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }
}
