/**
 * 事件标签生成器（规则驱动，非机器学习推理）
 *
 * 说明：本模块仅根据单据字段做字符串规则匹配，生成便于列表检索与展示的标签。
 * 不含任何模型推理、目标检测或人像特征提取能力；如后续接入 ONNX 等推理引擎，
 * 应新建独立模块，不要在此处混入，以免标签来源真假难辨。
 *
 * 调用时机：仅在解包引擎完成 MD5 校验和与 HMAC 验签**之后**调用，
 * 因此可直接标注完整性校验已通过。
 */
function buildEventTags(eventRecord) {
  const tags = ['完整性校验: MD5 + HMAC 签名通过'];
  const payload = (eventRecord && eventRecord.payload) || {};

  if (payload.transportation) {
    tags.push(`交通工具: ${payload.transportation}`);
  }
  if (payload.person_name) {
    tags.push(`关联人员: ${payload.person_name}`);
  }
  if (payload.location) {
    tags.push(`发生地点: ${payload.location}`);
  }

  const imageCount = Array.isArray(eventRecord && eventRecord.files)
    ? eventRecord.files.length
    : 0;
  if (imageCount > 0) {
    tags.push(`随案图片: ${imageCount} 张`);
  }

  return tags;
}

module.exports = {
  buildEventTags
};
