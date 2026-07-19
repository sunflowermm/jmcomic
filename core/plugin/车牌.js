import fs from 'node:fs/promises'
import path from 'node:path'
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js'
import { buildSubserverFileLink } from '#utils/subserver-file-proxy.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const DEFAULT_CACHE_MAX_FILES = 15

export class ChepaiPlugin extends PluginBase {
  _recallTimers = new Set()

  constructor() {
    super({
      name: '车牌插件',
      dsc: '#车牌 下载；#开盲盒 [标签]；PDF 直链+群文件，两分钟撤回',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#车牌\\s*(.+)$', fnc: 'downloadPdf' },
        { reg: '^#开盲盒(?:\\s+(.+))?$', fnc: '盲盒' },
      ],
    })
  }

  async downloadPdf() {
    const albumId = (this.e.msg || '').replace(/^#车牌\s*/, '').trim()
    if (!/^\d+$/.test(albumId)) {
      await this.reply('请输入有效本子 ID，例：#车牌123456', true)
      return false
    }

    await this.reply('正在处理，请稍候…', true)
    return this._downloadAndDeliver(albumId)
  }

  /** #开盲盒 [标签] — 固定开 1 本；日志 tag=[盲盒] */
  async 盲盒() {
    const m = String(this.e.msg || '').match(/^#开盲盒(?:\s+(.+))?$/)
    const tag = String(m?.[1] || '').trim()
    if (tag && /^\d+$/.test(tag)) {
      await this.reply('开盲盒后请跟标签文案，不要跟数字。例：#开盲盒 全彩', true)
      return true
    }

    await this.reply(tag ? `开盲盒（${tag}）中，抽号并下载…` : '开盲盒中，抽号并下载…', true)

    try {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/blind-box', {
        body: tag ? { tag } : {},
        timeout: DOWNLOAD_TIMEOUT_MS,
      })

      if (!result?.ok || !result.pdf_path) {
        await this.reply(result?.error || result?.reason || '开盲盒失败', true)
        return true
      }

      const tagHint = result.tag ? `（${result.tag}）` : ''
      await this.reply(`抽到车牌：${result.album_id}${tagHint}`, true)
      logger.info(`[盲盒] 抽到 album=${result.album_id} source=${result.pick_source || ''}`)
      await this._deliverOneResult(result)
      return true
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      logger.error(`[盲盒] 失败: ${hint}`)
      await this.reply(hint, true)
      return true
    }
  }

  async _downloadAndDeliver(albumId) {
    try {
      const result = await AgentRuntime.callSubserver('/api/jmcomic/download', {
        body: { album_id: albumId },
        timeout: DOWNLOAD_TIMEOUT_MS,
      })

      if (!result?.ok || !result.pdf_path) {
        const reason = result?.error || result?.reason || '处理失败'
        const detail = result?.detail ? `\n（${result.detail}）` : ''
        await this.reply(`${reason}${detail}`, true)
        return true
      }

      if (result.cached) {
        logger.info(`[车牌] 子服务命中已有 PDF album=${albumId}`)
      }

      await this._deliverOneResult(result)
      return true
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      logger.error(`[车牌] 失败: ${hint}`)
      await this.reply(hint, true)
      return true
    }
  }

  async _deliverOneResult(result) {
    const albumId = String(result.album_id || '')
    const fileName = result.pdf_name || path.basename(result.pdf_path)
    const pdfPath = await this._resolvePdfPath(result, albumId)
    await this._pruneLocalCache(albumId)

    const { msgIds } = await this._deliverPdf(result, pdfPath, fileName, albumId)
    if (msgIds.length) {
      const timer = setTimeout(() => {
        this._recallTimers.delete(timer)
        this._recall(msgIds)
      }, RECALL_DELAY_MS)
      this._recallTimers.add(timer)
    }
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
      timeout: DOWNLOAD_TIMEOUT_MS
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
      const linkRes = await this.reply(`PDF 正在上传群文件，可先下载：\n${url}`, true)
      msgIds.push(...this._extractMsgIds(linkRes))
    }

    const fileRes = await this.reply([msgSegment.file(pdfPath, fileName)])
    if (fileRes && !fileRes.error && fileRes !== false) {
      msgIds.push(...this._extractMsgIds(fileRes))
      return { mode: 'file', msgIds }
    }

    const reason = Error.isError(fileRes?.error) ? fileRes.error.message : '发送失败'
    logger.warn(`[车牌] 群文件发送失败 album=${albumId} (${sizeMb}MB): ${reason}`)

    if (url) {
      return { mode: 'link-only', msgIds }
    }

    const fallback = await this.reply(
      `PDF 已就绪（${sizeMb}MB），群文件发送失败且无法生成公网直链。请在 server.yaml 配置 server.url，或在控制台「禁漫本子」配置 public_base_url`,
      true
    )
    msgIds.push(...this._extractMsgIds(fallback))
    return { mode: 'failed', msgIds }
  }

  async _buildDirectLinkUrl(result) {
    const { publicBaseUrl } = await this._readJmConfig()
    const base = await AgentRuntime.getPublicServerUrl(publicBaseUrl)
    return buildSubserverFileLink(base, result.pdf_path)
  }

  _extractMsgIds(msgRes) {
    if (!msgRes || msgRes.error || msgRes === false) return []
    if (Array.isArray(msgRes.message_id)) return msgRes.message_id.filter(Boolean)
    if (msgRes.message_id) return [msgRes.message_id]
    if (Array.isArray(msgRes.data)) {
      return msgRes.data.map(item => item?.message_id).filter(Boolean)
    }
    return []
  }

  _recall(msgIds) {
    const target = this.e.isGroup ? this.e.group : this.e.friend
    if (!target?.recallMsg) return

    for (const id of msgIds) {
      Promise.resolve(target.recallMsg(id)).catch(recallErr => {
        logger.debug(`[车牌] 撤回失败 msgId=${id}: ${normalizeError(recallErr).message}`)
      })
    }
  }

  destroy() {
    for (const timer of this._recallTimers) {
      clearTimeout(timer)
    }
    this._recallTimers.clear()
  }
}
