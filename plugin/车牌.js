import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const MAX_FILE_SEND_BYTES = 6 * 1024 * 1024

export class ChepaiPlugin extends plugin {
  constructor() {
    super({
      name: '车牌插件',
      dsc: '已有 PDF 直接发送；无缓存再下载；过大或超时改直链，两分钟后撤回',
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
      if (result.cached) {
        logger.info(`[车牌] 使用已有 PDF album=${albumId}`)
      }

      const delivery = await this._deliverPdf(result, pdfPath, fileName)
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

  async _deliverPdf(result, pdfPath, fileName) {
    const stat = await fs.stat(pdfPath)
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2)
    logger.info(`[车牌] PDF 就绪 ${fileName} (${sizeMb}MB)`)

    if (stat.size > MAX_FILE_SEND_BYTES) {
      return this._sendDownloadLink(result, pdfPath, fileName, sizeMb)
    }

    const msgRes = await this.reply([segment.file(pdfPath, fileName)])
    if (!msgRes || msgRes.error || msgRes === false) {
      const reason = Error.isError(msgRes?.error) ? msgRes.error.message : '发送失败'
      logger.warn(`[车牌] 文件发送失败(${sizeMb}MB)，改发直链: ${reason}`)
      return this._sendDownloadLink(result, pdfPath, fileName, sizeMb)
    }

    return { mode: 'file', msgRes }
  }

  async _sendDownloadLink(result, pdfPath, fileName, sizeMb) {
    const mediaName = await this._publishToMedia(pdfPath, fileName)
    const base = (Bot.getServerUrl?.() || Bot.url || '').replace(/\/+$/, '')
    if (!base) {
      const msgRes = await this.reply(
        `PDF 已就绪（${sizeMb}MB），无法直发群文件，且未配置 Bot 外网地址`
      )
      return { mode: 'link-failed', msgRes }
    }

    const url = `${base}/media/jmcomic/${encodeURIComponent(mediaName)}`
    const title = result.title || result.album_id
    const msgRes = await this.reply(`PDF 已就绪（${sizeMb}MB）\n${title}\n下载：${url}`)
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
