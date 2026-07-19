/**
 * jmcomic AI 工作流 — MCP：车牌下载 / 开盲盒
 *
 * 有会话 e：调子服 API → 用车牌插件交付 PDF（不走 PluginLoader.deal，
 * 避免同 message_id 被 msgThrottle 静默丢弃）。
 * 无会话：只返回下载元数据。
 */
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js'
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { ChepaiPlugin } from '../plugin/车牌.js'

const DOWNLOAD_TIMEOUT_MS = 600_000

function digitsOnly(raw) {
  const s = String(raw ?? '').trim()
  return /^\d+$/.test(s) ? s : null
}

export default class JmcomicStream extends AiWorkflow {
  constructor() {
    super({
      name: 'jmcomic',
      description: '禁漫本子：车牌下载（传数字）、开盲盒（无参随机一本）',
      version: '1.2.0',
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
      '- jmcomic.jm_download：用户给出本子车牌号（纯数字）时调用，参数 album_id。',
      '- jmcomic.jm_blind_box：开盲盒；可选 tag（如「全彩」）。用户说「开盲盒 xxx」时把 xxx 传入 tag。',
      '工具成功返回表示下载已完成；有 QQ 会话时 PDF 已发送。根据返回的 album_id/title 告知结果，不要再说「正在下载」。',
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
        '开盲盒：随机抽 1 本并下载。可选 tag=禁漫标签（如全彩）；不传则用配置或日榜。成功后 PDF 已发送（有会话时）。',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: '可选。禁漫标签文案（非数字），按标签池随机抽一本',
          },
        },
        required: [],
      },
      handler: async (args = {}) => {
        const tag = String(args.tag ?? args.tags ?? '').trim()
        if (tag && /^\d+$/.test(tag)) {
          return this.errorResponse('INVALID_PARAM', 'tag 不能为纯数字')
        }
        return this._runBlindBox(tag)
      },
      enabled: true,
    })
  }

  _sessionEvent() {
    return getWorkflowRequestContext()?.e || null
  }

  /** 挂会话 e，复用车牌插件的 PDF 拉取/群文件/直链交付 */
  async _deliverToSession(e, result, tag = '[车牌]') {
    const plugin = new ChepaiPlugin()
    plugin.e = e
    RuntimeUtil.makeLog('info', `${tag} AI 会话交付 album=${result.album_id}`, 'JmcomicStream')
    await plugin._deliverOneResult(result)
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
    }
  }

  async _runDownload(albumId) {
    const e = this._sessionEvent()
    try {
      if (e?.reply) await e.reply(`正在下载车牌 ${albumId}…`)
      const result = await this._callDownloadApi(albumId)
      if (e) await this._deliverToSession(e, result, '[车牌]')
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[车牌] API 失败: ${hint}`, 'JmcomicStream')
      if (e?.reply) await e.reply(hint).catch(() => {})
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }

  async _runBlindBox(tag = '') {
    const e = this._sessionEvent()
    try {
      const tip = tag ? `开盲盒（tag:${tag}）中，抽号并下载…` : '开盲盒中，抽号并下载…'
      if (e?.reply) await e.reply(tip)
      RuntimeUtil.makeLog('info', `[盲盒] 开始抽号${tag ? ` tag=${tag}` : ''}`, 'JmcomicStream')
      const result = await this._callBlindBoxApi(tag)
      RuntimeUtil.makeLog(
        'info',
        `[盲盒] 抽到 album=${result.album_id} source=${result.pick_source || ''} title=${result.title || ''}`,
        'JmcomicStream'
      )
      if (e) {
        const tagHint = result.tag ? `（${result.tag}）` : ''
        await e.reply(`抽到车牌：${result.album_id}${tagHint}`)
        await this._deliverToSession(e, result, '[盲盒]')
      }
      return this.successResponse({
        mode: e ? 'session' : 'api',
        delivered: Boolean(e),
        source: 'blind_box',
        ...this._meta(result),
      })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[盲盒] 失败: ${hint}`, 'JmcomicStream')
      if (e?.reply) await e.reply(hint).catch(() => {})
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }
}
