'use strict';

// 插件市场分类与作者启发（纯，无 IO）：关键词分类表 + classify + pickAuthor。

const CATEGORIES = {
  '官方生态': ['@deepseek-ai', 'deepseek-harness官方', 'official'],
  '免费模型源': ['free-provider', 'free-vision', 'opus', 'codex', 'openrouter', 'provider', 'subscription', 'chatgpt', 'gemini', 'claude'],
  '工具增强': ['tool', 'bash', 'fs', 'edit', 'search', 'web', 'browser', 'vision', 'vision-proxy', 'computer-use', 'shell'],
  '记忆管理': ['memory', 'memo', 'context', 'mnemon', 'auto-memory', 'knowledge', 'memos'],
  '自动化': ['workflow', 'crew', 'auto', 'schedule', 'cron', 'agent-teams', 'multi-agent', 'orchestrat', 'iterate', 'loop'],
  '视觉图像': ['vision', 'image', 'diagram', 'excalidraw', 'skin', 'theme', 'wallpaper', 'pet', 'background'],
  '远程访问': ['remote', 'lan', 'mobile', 'access', 'pocket', 'desktop', 'bridge', 'tui', 'pi'],
  '聊天集成': ['feishu', 'lark', 'wechat', 'wecom', 'im', 'bot', 'qq', 'telegram'],
  '数据管理': ['usage', 'cost', 'account', 'wallet', 'stat', 'quota', 'token', 'billing'],
  '其他': [],
};

function classify(pkg) {
  const text = (pkg.name + ' ' + (pkg.description || '') + ' ' + (pkg.keywords || []).join(' ')).toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORIES)) {
    if (cat === '其他') continue;
    for (const kw of kws) {
      if (text.includes(kw.toLowerCase())) return cat;
    }
  }
  return '其他';
}

function pickAuthor(meta) {
  const a = meta.author;
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.name || null;
}

module.exports = { classify, pickAuthor };
