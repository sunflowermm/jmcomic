import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';
import fields from './shared/jmcomic.fields.js';

export default class JmcomicConfig extends ConfigBase {
  constructor() {
    super({
      name: 'jmcomic',
      displayName: '禁漫本子',
      description: 'jmcomic 子服插件：下载/PDF/压缩与 QQ 交付',
      filePath: 'data/jmcomic/config.yaml',
      fileType: 'yaml',
      defaultTemplatePath: 'subserver/pyserver/apis/jmcomic/default_config.yaml',
      schema: { fields }
    });
  }
}
