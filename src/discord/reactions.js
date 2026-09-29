// 回复中的 [[react:😀]] / [[react:<:name:id>]] 标记：从正文中移除，转成对触发消息的表情反应。
const TAG = /\[\[\s*react\s*[:：]\s*([^\]\n]{1,80}?)\s*\]\]/gi;
// [[sticker:名字]]：从正文中移除，转成随回复一起发出的服务器贴纸。
const STICKER_TAG = /\[\[\s*sticker\s*[:：]\s*([^\]\n]{1,60}?)\s*\]\]/gi;
const CUSTOM = /^<a?:[\w~]{2,32}:\d{15,25}>$/;
// Unicode 表情：由表情符号、变体选择符、零宽连接符、肤色与旗帜区域符组成。
const UNICODE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\u20e3#*0-9])+$/u;
export const MAX_REACTIONS = 3;
// Discord 一条消息最多 3 张贴纸。
export const MAX_STICKERS = 3;

const tidy = text => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function isReactionEmoji(value) {
  const text = String(value || '').trim();
  return CUSTOM.test(text) || (UNICODE.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text));
}

export function extractReactions(text) {
  const reactions = [];
  const cleaned = String(text || '').replace(TAG, (_, emoji) => {
    const value = emoji.trim();
    if (isReactionEmoji(value) && !reactions.includes(value) && reactions.length < MAX_REACTIONS) reactions.push(value);
    return '';
  });
  return { text: tidy(cleaned), reactions };
}

export function extractStickers(text) {
  const stickers = [];
  const cleaned = String(text || '').replace(STICKER_TAG, (_, name) => {
    const value = name.trim().replace(/^:(.+):$/, '$1');
    if (value && !stickers.includes(value) && stickers.length < MAX_STICKERS) stickers.push(value);
    return '';
  });
  return { text: tidy(cleaned), stickers };
}

// 把贴纸名解析成本服务器可用贴纸的 ID：先精确匹配名字（不分大小写），再按 ID，最后按关联表情。
export function resolveStickers(names, available) {
  const ids = [];
  const missing = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const found = available.find(s => s.name.toLowerCase() === key) || available.find(s => s.id === name)
      || available.find(s => (s.tags || '').split(/[,，\s]+/).includes(name));
    if (found && !ids.includes(found.id)) ids.push(found.id);
    else if (!found) missing.push(name);
  }
  return { ids, missing };
}

// 流式预览时去掉完整的标记以及结尾处尚未写完的半截标记。
export function stripReactionTags(text) {
  return String(text || '').replace(TAG, '').replace(STICKER_TAG, '')
    .replace(/\[\[?(?:\s*(?:r(?:e(?:a(?:c(?:t(?:\s*[:：][^\]\n]*)?)?)?)?)?|s(?:t(?:i(?:c(?:k(?:e(?:r(?:\s*[:：][^\]\n]*)?)?)?)?)?)?)?))?$/i, '').trimEnd();
}
