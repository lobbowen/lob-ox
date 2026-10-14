import { toast } from "sonner";

/**
 * 剪贴板复制的唯一实现：clipboard API → execCommand → 明确报错。
 * 返回是否复制成功；成功提示只在这里发一次，不存在「非抛异常路径也报成功」。
 */
export async function copyText(text: string, okMsg = "已复制"): Promise<boolean> {
  if (!text) { toast.error("没有可复制的内容"); return false; }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast.success(okMsg);
      return true;
    }
  } catch { /* 非安全上下文或权限被拒：落到 execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    // 返回值必须检查：不检查时静默失败也会被报成「已复制」。
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) throw new Error("execCommand 返回 false");
    toast.success(okMsg);
    return true;
  } catch (e) {
    toast.error("复制失败，请手动选中复制" + (e instanceof Error ? "" : "：" + String(e)));
    return false;
  }
}
