import fs from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000

export class ChepaiPlugin extends plugin {
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
        await this.reply(result?.error || '处理失败，请检查本子 ID 或子服务端日志')
        return false
      }

      const fileName = result.pdf_name || path.basename(result.pdf_path)
      if (!this._pdfMatchesAlbum(fileName, albumId)) {
        logger.error(`[车牌] 子服务返回了错误 PDF album=${albumId} file=${fileName}`)
        await this.reply(`PDF 与本子 ID 不匹配（请求 ${albumId}，得到 ${fileName}），请重试或删除 data/jmcomic/pdf 后重新下载`)
        return false
      }

      const pdfPath = await this._resolvePdfPath(result, albumId)
      if (result.cached) {
        logger.info(`[车牌] 子服务命中已有 PDF album=${albumId}`)
      }

      const { msgIds } = await this._deliverPdf(result, pdfPath, fileName, albumId)
      if (msgIds.length) {
        setTimeout(() => this._recall(msgIds), RECALL_DELAY_MS)
      }
      return true
    } catch (err) {
      const error = normalizeError(err)
      logger.error(`[车牌] 失败: ${error.message}`)
      await this.reply('处理失败，请确认 JM 子服务插件已部署且依赖已安装')
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
    logger.info(`[车牌] 已从子服务端拉取 PDF album=${albumId}`)
    return cachePath
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
    const override = await this._readJmPublicBaseUrl()
    const base = await Bot.getPublicServerUrl(override)
    if (!base) return ''
    const params = new URLSearchParams({ path: result.pdf_path })
    return `${base}/subserver-file?${params}`
  }

  async _readJmPublicBaseUrl() {
    try {
      const file = path.join(process.cwd(), 'data/jmcomic/config.yaml')
      const text = await fs.readFile(file, 'utf8')
      const data = parseYaml(text) || {}
      return String(data.public_base_url || data.qq?.public_base_url || '').trim()
    } catch {
      return ''
    }
  }

  _pdfMatchesAlbum(fileName, albumId) {
    const base = path.basename(fileName)
    const stem = base.replace(/\.pdf$/i, '')
    const prefix = `[JM${albumId}]`
    return base === `${albumId}.pdf` || stem === albumId
      || stem.startsWith(prefix) || base.startsWith(prefix)
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
}
