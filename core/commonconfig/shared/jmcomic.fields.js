/** jmcomic CommonConfig schema 字段（与 default_config.yaml 对齐） */
export default {
  download_dir: {
    type: 'string',
    label: '下载临时目录',
    description: '相对仓库根；合成 PDF 后按 delete_original 清理',
    component: 'Input',
    default: 'data/jmcomic/download'
  },
  pdf_dir: {
    type: 'string',
    label: 'PDF 存放目录',
    description: '二次请求直接读此目录已有 PDF',
    component: 'Input',
    default: 'data/jmcomic/pdf'
  },
  delete_original: {
    type: 'boolean',
    label: '合成后删除原图',
    default: true,
    component: 'Switch'
  },
  reuse_existing_pdf: {
    type: 'boolean',
    label: '复用已有 PDF',
    default: true,
    component: 'Switch'
  },
  max_concurrent_downloads: {
    type: 'number',
    label: '并发下载数',
    min: 1,
    max: 2,
    default: 1,
    component: 'InputNumber'
  },
  limits: {
    type: 'object',
    label: '体量限制',
    component: 'SubForm',
    fields: {
      preflight: { type: 'boolean', label: '下载前预检', default: true, component: 'Switch' },
      max_pages: { type: 'number', label: '最大页数', min: 1, default: 300, component: 'InputNumber' },
      max_episodes: { type: 'number', label: '最大章节数', min: 1, default: 50, component: 'InputNumber' },
      max_pdf_mb: {
        type: 'number',
        label: '压缩后 PDF 上限 (MB)',
        description: '0 表示不限制',
        min: 0,
        default: 50,
        component: 'InputNumber'
      },
      download_timeout_sec: {
        type: 'number',
        label: '下载超时 (秒)',
        min: 60,
        default: 900,
        component: 'InputNumber'
      },
      pages_per_episode_estimate: {
        type: 'number',
        label: '每章预估页数',
        min: 1,
        default: 10,
        component: 'InputNumber'
      }
    }
  },
  pdf_compress: {
    type: 'object',
    label: 'PDF/图片压缩',
    component: 'SubForm',
    fields: {
      enabled: { type: 'boolean', label: '启用压缩', default: true, component: 'Switch' },
      compress_at_download: { type: 'boolean', label: '下载时压图', default: true, component: 'Switch' },
      jpeg_quality: { type: 'number', label: 'JPEG 质量', min: 45, max: 92, default: 62, component: 'InputNumber' },
      max_image_width: { type: 'number', label: '图片长边上限 (px)', min: 0, default: 1080, component: 'InputNumber' },
      min_bytes: { type: 'number', label: 'PDF fallback 最小体积 (字节)', default: 262144, component: 'InputNumber' },
      min_savings_ratio: { type: 'number', label: '最小节省比例', min: 0, max: 1, default: 0, component: 'InputNumber' },
      optimize_cached: { type: 'boolean', label: '二次请求重压已有 PDF', default: false, component: 'Switch' },
      fallback_jpeg_quality: { type: 'number', label: '二次强压 JPEG 质量', min: 30, max: 85, default: 52, component: 'InputNumber' },
      fallback_max_image_width: { type: 'number', label: '二次强压长边 (px)', min: 0, default: 900, component: 'InputNumber' }
    }
  },
  client: {
    type: 'object',
    label: '禁漫客户端',
    component: 'SubForm',
    fields: {
      impl: { type: 'string', label: '实现', component: 'Input', default: 'api' }
    }
  },
  public_base_url: {
    type: 'string',
    label: '公网访问前缀',
    description: 'QQ 直链；留空则用 server.url',
    component: 'Input',
    default: ''
  },
  qq: {
    type: 'object',
    label: 'QQ 交付',
    component: 'SubForm',
    fields: {
      cache_max_files: { type: 'number', label: '本地 PDF 缓存份数', min: 1, default: 15, component: 'InputNumber' }
    }
  },
  blind_box: {
    type: 'object',
    label: '开盲盒',
    component: 'SubForm',
    fields: {
      tag: {
        type: 'string',
        label: '默认标签',
        description: '非空则用 search_tag；指令 #开盲盒 标签 / AI tag 可临时覆盖',
        component: 'Input',
        default: ''
      },
      ranking: {
        type: 'string',
        label: '排行榜',
        description: '无 tag 时：day / week / month',
        component: 'Input',
        default: 'day'
      },
      category: { type: 'string', label: '分类 ID', component: 'Input', default: '0' },
      page: { type: 'number', label: '搜索/排行榜页码', min: 1, default: 1, component: 'InputNumber' },
      seed_ids: {
        type: 'array',
        label: '指定车牌池',
        description: '非空则优先从此列表随机抽 1 个',
        component: 'Input',
        default: []
      }
    }
  }
};
