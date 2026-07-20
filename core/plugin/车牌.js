import fs from 'node:fs/promises'
import path from 'node:path'
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js'
import { buildSubserverFileLink } from '#utils/subserver-file-proxy.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { normalizeError } from '#utils/normalize-error.js'
import { extractMsgIds, scheduleMsgRecall } from '#utils/msg-recall.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const DEFAULT_CACHE_MAX_FILES = 15
const RECALL_TAG = '车牌撤回'

function scheduleAll(e, msgIds) {
  return scheduleMsgRecall(e, msgIds, { delayMs: RECALL_DELAY_MS, logTag: RECALL_TAG })
}

export class ChepaiPlugin extends PluginBase {
  constructor() {
    super({
      name: '车牌插件',
      dsc: '#车牌；#开盲盒 [标签…]（空格多标签）；文字/直链/PDF 两分钟同时撤回',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#车牌\\s*(.+)$', fnc: 'downloadPdf' },
        { reg: '^#开盲盒(?:\\s+(.+))?$', fnc: '盲盒' },
      ],
    })
  }

  /** 文字/链接：引用；收集 id，交付完成后再统一定时撤回 */
  async _replyText(msg) {
    const res = await this.reply(msg, true)
    return extractMsgIds(res)
  }

  async downloadPdf() {
    const albumId = (this.e.msg || '').replace(/^#车牌\s*/, '').trim()
    if (!/^\d+$/.test(albumId)) {
      await this._replyText('请输入有效本子 ID，例：#车牌123456')
      return false
    }

    const ids = [...(await this._replyText('正在处理，请稍候…'))]
    ids.push(...(await this._downloadAndDeliver(albumId)))
    scheduleAll(this.e, ids)
    return true
  }

  /** #开盲盒 [标签] — 固定开 1 本；文字+链接+PDF 一并撤回 */
  async 盲盒() {
    const m = String(this.e.msg || '').match(/^#开盲盒(?:\s+(.+))?$/)
    const tag = String(m?.[1] || '').trim()
    if (tag && /^\d+$/.test(tag)) {
      await this._replyText(
        '开盲盒 tag 不能为纯数字。多标签空格分隔，例：#开盲盒 全彩 中文\n也可用：#开盲盒 +全彩 +中文 -CG'
      )
      return true
    }

    const ids = [
      ...(await this._replyText(
        tag ? `开盲盒（${tag}）中，抽号并下载…` : '开盲盒中，抽号并下载…'
      )),
    ]

    try {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/blind-box', {
        body: tag ? { tag } : {},
        timeout: DOWNLOAD_TIMEOUT_MS,
      })

      if (!result?.ok || !result.pdf_path) {
        ids.push(...(await this._replyText(result?.error || result?.reason || '开盲盒失败')))
        scheduleAll(this.e, ids)
        return true
      }

      const tagHint = result.tag_query || result.tag ? `（${result.tag_query || result.tag}）` : ''
      ids.push(...(await this._replyText(`抽到车牌：${result.album_id}${tagHint}`)))
      logger.info(
        `[盲盒] 抽到 album=${result.album_id} source=${result.pick_source || ''} query=${result.tag_query || ''}`
      )
      ids.push(...(await this._deliverOneResult(result)))
      scheduleAll(this.e, ids)
      return true
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      logger.error(`[盲盒] 失败: ${hint}`)
      ids.push(...(await this._replyText(hint)))
      scheduleAll(this.e, ids)
      return true
    }
  }

  /** @returns {Promise<Array<string|number>>} */
  async _downloadAndDeliver(albumId) {
    const ids = []
    try {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/download', {
        body: { album_id: albumId },
        timeout: DOWNLOAD_TIMEOUT_MS,
      })

      if (!result?.ok || !result.pdf_path) {
        const reason = result?.error || result?.reason || '处理失败'
        const detail = result?.detail ? `\n（${result.detail}）` : ''
        ids.push(...(await this._replyText(`${reason}${detail}`)))
        return ids
      }

      if (result.cached) {
        logger.info(`[车牌] 子服务命中已有 PDF album=${albumId}`)
      }

      ids.push(...(await this._deliverOneResult(result)))
      return ids
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      logger.error(`[车牌] 失败: ${hint}`)
      ids.push(...(await this._replyText(hint)))
      return ids
    }
  }

  /**
   * 交付：直链（引用）+ PDF 群文件（不引用）；返回全部 message_id
   * @returns {Promise<Array<string|number>>}
   */
  async _deliverOneResult(result) {
    const albumId = String(result.album_id || '')
    const fileName = result.pdf_name || path.basename(result.pdf_path)
    const pdfPath = await this._resolvePdfPath(result, albumId)
    await this._pruneLocalCache(albumId)
    return this._deliverPdf(result, pdfPath, fileName, albumId)
  }

  async _resolvePdfPath(result, albumId) {
    const localPath = path.isAbsolute(result.pdf_path)
      ? result.pdf_path
      : path.join(process.cwd(), result.pdf_path)

    try {
      await fs.access(localPath)
      return localPath
    } catch { /* 远程子服务，本地无 PDF */ }

    const cachePath = path.join(process.cwd(), 'data/jmcomic/cache', `${albumId}.pdf`)
    try {
      const stat = await fs.stat(cachePath)
      if (!result.size || stat.size === result.size) {
        logger.info(`[车牌] 使用本地缓存 album=${albumId}`)
        return cachePath
      }
    } catch { /* 需从子服务拉取 */ }

    await AgentRuntime.fetchSubserverToPath('/api/jmcomic/file', {
      query: { path: result.pdf_path },
      dest: cachePath,
      timeout: DOWNLOAD_TIMEOUT_MS,
    })
    logger.info(`[车牌] 已从子服务端流式拉取 PDF album=${albumId}`)
    return cachePath
  }

  async _pruneLocalCache(keepAlbumId) {
    const { cacheMaxFiles } = await this._readJmConfig()
    const cacheDir = path.join(process.cwd(), 'data/jmcomic/cache')
    try {
      const entries = await fs.readdir(cacheDir)
      const files = []
      for (const name of entries) {
        if (!name.endsWith('.pdf')) continue
        const full = path.join(cacheDir, name)
        const stat = await fs.stat(full)
        files.push({ full, name, mtime: stat.mtimeMs })
      }
      if (files.length <= cacheMaxFiles) return

      files.sort((a, b) => a.mtime - b.mtime)
      const keepName = `${keepAlbumId}.pdf`
      let removed = 0
      for (const item of files) {
        if (files.length - removed <= cacheMaxFiles) break
        if (item.name === keepName) continue
        await fs.unlink(item.full).catch(() => {})
        removed += 1
      }
      if (removed > 0) {
        logger.info(`[车牌] 已清理 ${removed} 个过期 PDF 缓存`)
      }
    } catch {
      /* cache 目录不存在时忽略 */
    }
  }

  async _readJmConfig() {
    const entry = CommonConfigRegistry.get('jmcomic')
    if (entry?.read) {
      try {
        const data = await entry.read()
        return this._pickQqFields(data)
      } catch (err) {
        logger.debug(`[车牌] 读取 jmcomic 配置失败: ${normalizeError(err).message}`)
      }
    }
    return { cacheMaxFiles: DEFAULT_CACHE_MAX_FILES, publicBaseUrl: '' }
  }

  _pickQqFields(data) {
    const raw = data?.qq?.cache_max_files
    const n = Number(raw)
    const cacheMaxFiles = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CACHE_MAX_FILES
    const publicBaseUrl = String(data?.public_base_url || '').trim()
    return { cacheMaxFiles, publicBaseUrl }
  }

  async _deliverPdf(result, pdfPath, fileName, albumId) {
    const stat = await fs.stat(pdfPath)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
    logger.info(`[车牌] PDF 就绪 album=${albumId} ${fileName} (${sizeMb}MB)`)

    const msgIds = []
    const url = await this._buildDirectLinkUrl(result)

    if (url) {
      msgIds.push(...(await this._replyText(`PDF 正在上传群文件，可先下载：\n${url}`)))
    }

    // 群文件：不引用，但仍收集 message_id 与文字/链接一并撤回
    const fileRes = await this.reply([msgSegment.file(pdfPath, fileName)])
    if (fileRes && !fileRes.error && fileRes !== false) {
      const fileIds = extractMsgIds(fileRes)
      if (!fileIds.length) {
        logger.warn(`[车牌] PDF 已发送但未解析到 message_id，无法定时撤回群文件 album=${albumId}`)
      }
      msgIds.push(...fileIds)
      return msgIds
    }

    const reason = Error.isError(fileRes?.error) ? fileRes.error.message : '发送失败'
    logger.warn(`[车牌] 群文件发送失败 album=${albumId} (${sizeMb}MB): ${reason}`)

    if (url) return msgIds

    msgIds.push(
      ...(await this._replyText(
        `PDF 已就绪（${sizeMb}MB），群文件发送失败且无法生成公网直链。请在 server.yaml 配置 server.url，或在控制台「禁漫本子」配置 public_base_url`
      ))
    )
    return msgIds
  }

  async _buildDirectLinkUrl(result) {
    const { publicBaseUrl } = await this._readJmConfig()
    const base = await AgentRuntime.getPublicServerUrl(publicBaseUrl)
    return buildSubserverFileLink(base, result.pdf_path)
  }
}

export { extractMsgIds, scheduleMsgRecall }
