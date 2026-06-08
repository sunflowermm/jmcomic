import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeError } from '#utils/normalize-error.js'

const RECALL_DELAY_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 600_000

export class ChepaiPlugin extends plugin {
  constructor() {
    super({
      name: '车牌插件',
      dsc: '通过 JM 子服务插件下载本子 PDF，两分钟后自动撤回',
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
      const msgRes = await this.reply([segment.file(pdfPath, fileName)])

      const msgIds = this._extractMsgIds(msgRes)
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
    if (!msgRes) return []
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
