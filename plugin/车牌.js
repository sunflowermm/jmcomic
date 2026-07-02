import fs from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildSubserverFileLink } from '#utils/subserver-file-proxy.js'
import { formatSubserverError, getSubserverConfig } from '#utils/subserver-client.js'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const DEFAULT_CACHE_MAX_FILES = 30

export class ChepaiPlugin extends plugin {
  _recallTimers = new Set()

  constructor() {
    super({
      name: '车牌插件',
      dsc: '下载 PDF 后先发直链，再上传群文件，两分钟后撤回',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^#车牌\\s*(.+)$', fnc: 'downloadPdf' }]
    })
  }

  async downloadPdf() {
    const albumId = (this.e.msg || '').replace(/^#车牌\s*/, '').trim()
    if (!/^\d+$/.test(albumId)) {
      await this.reply('请输入有效本子 ID，例：#车牌123456')
      return false
    }

    await this.reply('正在处理，请稍候…')

    try {
      const result = await Bot.callSubserver('/api/jmcomic/download', {
        body: { album_id: albumId },
        timeout: DOWNLOAD_TIMEOUT_MS
      })

      if (!result?.ok || !result.pdf_path) {
        const reason = result?.error || result?.reason || '处理失败'
        const detail = result?.detail ? `\n（${result.detail}）` : ''
        await this.reply(`${reason}${detail}`)
        return false
      }

      const fileName = result.pdf_name || path.basename(result.pdf_path)
      const pdfPath = await this._resolvePdfPath(result, albumId)
      if (result.cached) {
        logger.info(`[车牌] 子服务命中已有 PDF album=${albumId}`)
      }

      await this._pruneLocalCache(albumId)

      const { msgIds } = await this._deliverPdf(result, pdfPath, fileName, albumId)
      if (msgIds.length) {
        const timer = setTimeout(() => {
          this._recallTimers.delete(timer)
          this._recall(msgIds)
        }, RECALL_DELAY_MS)
        this._recallTimers.add(timer)
      }
      return true
    } catch (err) {
      const hint = formatSubserverError(err, getSubserverConfig())
      logger.error(`[车牌] 失败: ${hint}`)
      await this.reply(hint)
      return false
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

    await Bot.fetchSubserverToPath('/api/jmcomic/file', {
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
    try {
      const file = path.join(process.cwd(), 'data/jmcomic/config.yaml')
      const text = await fs.readFile(file, 'utf8')
      const data = parseYaml(text) || {}
      const raw = data.qq?.cache_max_files ?? data.cache_max_files
      const n = Number(raw)
      const cacheMaxFiles = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CACHE_MAX_FILES
      const publicBaseUrl = String(data.public_base_url || data.qq?.public_base_url || '').trim()
      return { cacheMaxFiles, publicBaseUrl }
    } catch {
      return { cacheMaxFiles: DEFAULT_CACHE_MAX_FILES, publicBaseUrl: '' }
    }
  }

  async _deliverPdf(result, pdfPath, fileName, albumId) {
    const stat = await fs.stat(pdfPath)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
    logger.info(`[车牌] PDF 就绪 album=${albumId} ${fileName} (${sizeMb}MB)`)

    const msgIds = []
    const url = await this._buildDirectLinkUrl(result)

    if (url) {
      const linkRes = await this.reply(`PDF 正在上传群文件，可先下载：\n${url}`)
      msgIds.push(...this._extractMsgIds(linkRes))
    }

    const fileRes = await this.reply([segment.file(pdfPath, fileName)])
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
      `PDF 已就绪（${sizeMb}MB），群文件发送失败且无法生成公网直链。请在 server.yaml 配置 server.url，或在 data/jmcomic/config.yaml 配置 public_base_url`
    )
    msgIds.push(...this._extractMsgIds(fallback))
    return { mode: 'failed', msgIds }
  }

  async _buildDirectLinkUrl(result) {
    const { publicBaseUrl } = await this._readJmConfig()
    const base = await Bot.getPublicServerUrl(publicBaseUrl)
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

export default ChepaiPlugin
