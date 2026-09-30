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

// lookup(name) 把服务器表情名换成完整标签，让 [[react::name:]] / [[react:name]] 也能用。
export function extractReactions(text, lookup = () => null) {
  const reactions = [];
  const cleaned = String(text || '').replace(TAG, (_, emoji) => {
    let value = emoji.trim();
    if (!isReactionEmoji(value)) value = lookup(value.replace(/^:(.+):$/, '$1')) || value;
    if (isReactionEmoji(value) && !reactions.includes(value) && reactions.length < MAX_REACTIONS) reactions.push(value);
    return '';
  });
  return { text: tidy(cleaned), reactions };
}

const CUSTOM_IN_TEXT = /<(a?):([\w~]{2,32}):(\d{15,25})>/g;

// 对方消息里的自定义表情附上画面描述：<:emoji_52:123> → <:emoji_52:123>（表情：流萤捂脸害羞）。
export function annotateEmojis(text, noteFor) {
  return String(text || '').replace(CUSTOM_IN_TEXT, (tag, _animated, _name, id) => {
    const note = noteFor(id);
    return note ? `${tag}（表情：${note}）` : tag;
  });
}

// 所有自定义表情引用：{ id, name, animated }，用来把陌生表情（其他服务器的）也排进描述队列。
export function customEmojisIn(text) {
  return [...String(text || '').matchAll(CUSTOM_IN_TEXT)].map(([, animated, name, id]) => ({ id, name, animated: animated === 'a' }));
}

// 回复正文里的 :名字: 换成服务器表情标签（代码块和行内代码里的不动，已经是完整标签的不动）。
export function resolveEmojiNames(text, lookup) {
  return String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 ? part
    : part.replace(/(?<![<\w]|<a):([\w~]{2,32}):(?!\d)/g, (raw, name) => lookup(name) || raw)).join('');
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
