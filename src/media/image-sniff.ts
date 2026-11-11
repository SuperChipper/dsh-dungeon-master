/**
 * 按文件头认图片格式。扩展名和服务端声明的类型都不可信（QQ 的图常常没扩展名，
 * 下载到的也可能是一张 403 页面），所以收图、发图、交给模型之前都先过这里。
 *
 * vision-tool.ts 里还有一份同样的判断：那是上游的文件，为了以后同步上游时少一处分叉没有改它。
 */
export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 越界读到的是 undefined，比较自然不成立，所以不用先判长度 */
export function sniffImageMediaType(bytes: Uint8Array): SniffedImageType | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

export type SniffedImageExt = 'png' | 'jpg' | 'gif' | 'webp';

const EXT: Record<SniffedImageType, SniffedImageExt> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 文件头对应的扩展名（不带点） */
export function sniffImageExt(bytes: Uint8Array): SniffedImageExt | undefined {
  const type = sniffImageMediaType(bytes);
  return type === undefined ? undefined : EXT[type];
}
