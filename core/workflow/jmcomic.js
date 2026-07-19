/**
 * jmcomic AI 工作流 — MCP：车牌下载（数字）/ 开盲盒（无参）
 * 有会话 e 时代发 #车牌 / #开盲盒；否则只调子服 API。
 */
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js'
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js'
import PluginLoader from '#infrastructure/plugins/loader.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'

const DOWNLOAD_TIMEOUT_MS = 600_000

function digitsOnly(raw) {
  const s = String(raw ?? '').trim()
  return /^\d+$/.test(s) ? s : null
}

/** 在当前会话上克隆一条可被 PluginLoader 匹配的消息事件 */
function cloneMsgEvent(e, msg) {
  const next = Object.create(Object.getPrototypeOf(e))
  Object.assign(next, e)
  next.msg = msg
  next.raw_message = msg
  next.message = [{ type: 'text', text: msg }]
  return next
}

export default class JmcomicStream extends AiWorkflow {
  constructor() {
    super({
      name: 'jmcomic',
      description: '禁漫本子：车牌下载（传数字）、开盲盒（无参随机一本）',
      version: '1.1.0',
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
      '- jmcomic.jm_blind_box：用户要开盲盒/随机一本时调用，无需参数（固定开 1 本）。',
      '有 QQ 会话时会代发 #车牌 / #开盲盒 并交付文件；无会话只返回下载元数据。',
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
      description: '开盲盒：从排行榜随机抽 1 本并下载。无需参数。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      handler: async () => this._runBlindBox(),
      enabled: true,
    })
  }

  /**
   * @param {string} command
   * @param {() => Promise<object>} apiFallback
   */
  async _withPluginOrApi(command, apiFallback) {
    const e = getWorkflowRequestContext()?.e
    if (e) {
      RuntimeUtil.makeLog('info', `[jmcomic] 代发插件指令: ${command}`, 'JmcomicStream')
      await PluginLoader.deal(cloneMsgEvent(e, command))
      return this.successResponse({ mode: 'plugin', command })
    }
    try {
      const data = await apiFallback()
      return this.successResponse({ mode: 'api', ...data })
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      RuntimeUtil.makeLog('error', `[jmcomic] API 失败: ${hint}`, 'JmcomicStream')
      return this.errorResponse('SUBSERVER_ERROR', hint)
    }
  }

  async _runDownload(albumId) {
    return this._withPluginOrApi(`#车牌${albumId}`, async () => {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/download', {
        body: { album_id: albumId },
        timeout: DOWNLOAD_TIMEOUT_MS,
        runtime: 'pyserver',
      })
      if (!result?.ok) {
        throw new Error(result?.error || result?.reason || '下载失败')
      }
      return {
        album_id: albumId,
        title: result.title,
        pdf_path: result.pdf_path,
        file_url: result.file_url,
        cached: result.cached,
        size: result.size,
      }
    })
  }

  async _runBlindBox() {
    return this._withPluginOrApi('#开盲盒', async () => {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/blind-box', {
        body: {},
        timeout: DOWNLOAD_TIMEOUT_MS,
        runtime: 'pyserver',
      })
      if (!result?.ok) {
        throw new Error(result?.error || result?.reason || '开盲盒失败')
      }
      return {
        album_id: result.album_id,
        title: result.title,
        pdf_path: result.pdf_path,
        file_url: result.file_url,
        cached: result.cached,
        size: result.size,
      }
    })
  }
}
