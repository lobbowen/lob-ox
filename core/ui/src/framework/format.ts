/** 与业务无关的通用格式化函数。 */

export function formatSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(0)} MB`;
  }

  if (size >= 1024) {
    return `${(size / 1024).toFixed(0)} KB`;
  }

  return `${size} B`;
}

