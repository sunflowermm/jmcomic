import fs from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import cfg from '#infrastructure/config/config.js'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const LOOPBACK_RE = /:\/\/(127(?:\.\d+){3}|localhost)(?:[:/]|$)/i

export class ChepaiPlugin extends plugin {
  constructor() {
    super({
      name: '车牌插件',
      dsc: '已有 PDF 直接发送；无缓存再下载；发送失败改公网直链，两分钟后撤回',
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

      const pdfPath = path.isAbsolute(result.pdf_path)
        ? result.pdf_path
        : path.join(process.cwd(), result.pdf_path)

      try {
        await fs.access(pdfPath)
      } catch {
        await this.reply('PDF 文件不存在，请稍后重试')
        return false
      }

      const fileName = result.pdf_name || path.basename(pdfPath)
      if (!this._pdfMatchesAlbum(fileName, albumId)) {
        logger.error(`[车牌] 子服务返回了错误 PDF album=${albumId} file=${fileName}`)
        await this.reply(`PDF 与本子 ID 不匹配（请求 ${albumId}，得到 ${fileName}），请重试或删除 data/jmcomic/pdf 后重新下载`)
        return false
      }

      if (result.cached) {
        logger.info(`[车牌] 使用已有 PDF album=${albumId}`)
      }

      const delivery = await this._deliverPdf(pdfPath, fileName, albumId)
      const msgIds = this._extractMsgIds(delivery.msgRes)
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

  async _deliverPdf(pdfPath, fileName, albumId) {
    const stat = await fs.stat(pdfPath)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
    logger.info(`[车牌] PDF 就绪 album=${albumId} ${fileName} (${sizeMb}MB)`)

    const msgRes = await this.reply([segment.file(pdfPath, fileName)])
    if (!msgRes || msgRes.error || msgRes === false) {
      const reason = Error.isError(msgRes?.error) ? msgRes.error.message : '发送失败'
      logger.warn(`[车牌] 群文件发送失败 album=${albumId} (${sizeMb}MB)，改发直链: ${reason}`)
      return this._sendDirectLink(pdfPath, fileName, sizeMb, albumId)
    }

    return { mode: 'file', msgRes }
  }

  async _sendDirectLink(pdfPath, fileName, sizeMb, albumId) {
    const mediaName = await this._publishToMedia(pdfPath, fileName, albumId)
    const base = await this._resolvePublicBaseUrl()
    if (!base) {
      const msgRes = await this.reply(
        `PDF 已就绪（${sizeMb}MB），群文件发送失败且无法生成公网直链。请在 server.yaml 配置 server.url，或在 data/jmcomic/config.yaml 配置 public_base_url`
      )
      return { mode: 'link-failed', msgRes }
    }

    const url = `${base}/media/jmcomic/${encodeURIComponent(mediaName)}`
    let msgRes = await this.reply([segment.file(url, fileName)])
    if (!msgRes || msgRes.error || msgRes === false) {
      msgRes = await this.reply(url)
    }
    return { mode: 'link', msgRes }
  }

  async _resolvePublicBaseUrl() {
    const override = await this._readJmPublicBaseUrl()
    if (override) return this._normalizeBaseUrl(override)

    const configured = (cfg?.server?.server?.url || Bot.url || '').trim()
    if (configured) {
      const normalized = this._normalizeBaseUrl(configured)
      if (normalized && !LOOPBACK_RE.test(normalized)) return normalized
    }

    const serverUrl = Bot.getServerUrl?.()
    if (serverUrl && !LOOPBACK_RE.test(serverUrl)) {
      return serverUrl.replace(/\/+$/, '')
    }

    if (typeof Bot.getLocalIpAddress !== 'function') return ''

    const ipInfo = await Bot.getLocalIpAddress()
    const protocol = cfg?.server?.https?.enabled === true ? 'https' : 'http'
    const port = Bot.actualPort || Bot.httpPort
    const needPort = (protocol === 'http' && port !== 80)
      || (protocol === 'https' && port !== 443)
    const portSuffix = needPort && port ? `:${port}` : ''

    if (ipInfo?.public) {
      return `${protocol}://${ipInfo.public}${portSuffix}`
    }

    const lan = ipInfo?.local?.find(item => item.primary) || ipInfo?.local?.[0]
    if (lan?.ip) {
      return `${protocol}://${lan.ip}${portSuffix}`
    }

    return ''
  }

  _normalizeBaseUrl(raw) {
    const text = String(raw || '').trim().replace(/\/+$/, '')
    if (!text) return ''
    if (/^https?:\/\//i.test(text)) return text
    const protocol = cfg?.server?.https?.enabled === true ? 'https' : 'http'
    return `${protocol}://${text.replace(/^\/+/, '')}`
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

  async _publishToMedia(pdfPath, fileName, albumId) {
    const base = path.basename(fileName).replace(/[^\w.\-[\]()\u4e00-\u9fff]+/g, '_')
      || `${albumId}.pdf`
    const safeName = `${albumId}_${base}`
    const mediaDir = path.join(process.cwd(), 'data/media/jmcomic')
    await fs.mkdir(mediaDir, { recursive: true })
    const dest = path.join(mediaDir, safeName)
    await fs.copyFile(pdfPath, dest)
    return safeName
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
