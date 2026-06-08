import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
/** OneBot send_msg 默认 60s；大文件 base64 上传易超时，超过此大小直接发直链 */
const MAX_FILE_SEND_BYTES = 6 * 1024 * 1024

export class ChepaiPlugin extends plugin {
  constructor() {
    super({
      name: '车牌插件',
      dsc: '通过 JM 子服务插件下载本子 PDF，过大或发送超时则改直链，两分钟后撤回',
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

    await this.reply('正在下载并生成 PDF，请稍候…')

    try {
      const result = await Bot.callSubserver('/api/jmcomic/download', {
        body: { album_id: albumId },
        timeout: DOWNLOAD_TIMEOUT_MS
      })

      if (!result?.ok || !result.pdf_path) {
        await this.reply(result?.error || '下载失败，请检查本子 ID 或子服务端日志')
        return false
      }

      const fileName = result.pdf_name || `${result.title || `album-${albumId}`}.pdf`
      const pdfPath = await this._resolvePdfPath(result.pdf_path, fileName)
      const delivery = await this._deliverPdf(result, pdfPath, fileName)

      const msgIds = this._extractMsgIds(delivery.msgRes)
      if (msgIds.length) {
        setTimeout(() => this._recall(msgIds), RECALL_DELAY_MS)
      }
      return true
    } catch (err) {
      const error = normalizeError(err)
      logger.error(`[车牌] 下载失败: ${error.message}`)
      await this.reply('下载失败，请确认 JM 子服务插件已部署且依赖已安装')
      return false
    }
  }

  async _deliverPdf(result, pdfPath, fileName) {
    const stat = await fs.stat(pdfPath)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
    logger.info(`[车牌] PDF 就绪 ${fileName} (${sizeMb}MB)`)

    if (stat.size > MAX_FILE_SEND_BYTES) {
      logger.info(`[车牌] 超过 ${MAX_FILE_SEND_BYTES / 1024 / 1024}MB，直接发直链`)
      return this._sendDownloadLink(result, pdfPath, fileName, sizeMb)
    }

    const msgRes = await this.reply([segment.file(pdfPath, fileName)])
    if (this._isSendFailure(msgRes)) {
      const reason = this._sendFailureReason(msgRes)
      logger.warn(`[车牌] 文件发送失败(${sizeMb}MB)，改发直链: ${reason}`)
      return this._sendDownloadLink(result, pdfPath, fileName, sizeMb)
    }

    return { mode: 'file', msgRes }
  }

  _isSendFailure(msgRes) {
    if (!msgRes) return true
    if (msgRes.error) return true
    if (msgRes === false) return true
    return false
  }

  _sendFailureReason(msgRes) {
    if (!msgRes) return '无响应'
    if (msgRes === false) return '发送返回 false'
    const err = msgRes.error
    if (Error.isError(err)) return err.message
    if (typeof err === 'string') return err
    if (err?.message) return String(err.message)
    return '未知错误'
  }

  async _sendDownloadLink(result, pdfPath, fileName, sizeMb) {
    const mediaName = await this._publishToMedia(pdfPath, fileName)
    const base = (Bot.getServerUrl?.() || Bot.url || '').replace(/\/+$/, '')
    if (!base) {
      const msgRes = await this.reply(
        `PDF 已生成（${sizeMb}MB），体积较大无法直发群文件，且未配置 Bot 外网地址，无法生成下载链接`
      )
      return { mode: 'link-failed', msgRes }
    }

    const url = `${base}/media/jmcomic/${encodeURIComponent(mediaName)}`
    const title = result.title || result.album_id
    const msgRes = await this.reply(
      `PDF 已就绪（${sizeMb}MB）\n${title}\n下载：${url}`
    )
    return { mode: 'link', msgRes }
  }

  async _publishToMedia(pdfPath, fileName) {
    const safeName = path.basename(fileName).replace(/[^\w.\-[\]()\u4e00-\u9fff]+/g, '_')
      || `album-${Date.now()}.pdf`
    const mediaDir = path.join(process.cwd(), 'data/media/jmcomic')
    await fs.mkdir(mediaDir, { recursive: true })
    const dest = path.join(mediaDir, safeName)
    await fs.copyFile(pdfPath, dest)
    return safeName
  }

  async _resolvePdfPath(relativePath, fileName) {
    const localPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(process.cwd(), relativePath)

    try {
      await fs.access(localPath)
      return localPath
    } catch {
      const res = await Bot.callSubserver('/api/jmcomic/file', {
        method: 'GET',
        query: { path: relativePath },
        rawResponse: true,
        timeout: DOWNLOAD_TIMEOUT_MS
      })
      const cacheDir = path.join(process.cwd(), 'data/jmcomic/cache')
      await fs.mkdir(cacheDir, { recursive: true })
      const cachePath = path.join(cacheDir, fileName)
      await fs.writeFile(cachePath, Buffer.from(await res.arrayBuffer()))
      return cachePath
    }
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
        const error = normalizeError(recallErr)
        logger.debug(`[车牌] 撤回失败 msgId=${id}: ${error.message}`)
      })
    }
  }
}
