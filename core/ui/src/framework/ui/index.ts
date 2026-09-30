/** UI 组件统一出口：组件命名遵循 shadcn/ui 风格（Radix + CVA + tailwind-merge）。 */
export { Button, type ButtonProps } from "./button";
export { Checkbox, type CheckboxProps } from "./checkbox";
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";
// 危险动作确认的唯一出口。alert-dialog 的原语**故意不进 barrel**：确认框只应由 useConfirm() 发起，
//  把 AlertDialog 摊给 features 等于把「统一出口」换回「各自拼一套确认样式」。
export { ConfirmProvider, useConfirm } from "./confirm";
export type { ConfirmRequest } from "./confirm-queue";
export { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
export { Input } from "./input";
export { Label } from "./label";
export { RadioGroup, RadioGroupItem } from "./radio-group";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
export { Toaster } from "./sonner";
export { Spinner } from "./spinner";
export { Switch } from "./switch";
export { Textarea } from "./textarea";

