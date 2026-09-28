// 回复中的 [[react:😀]] / [[react:<:name:id>]] 标记：从正文中移除，转成对触发消息的表情反应。
const TAG = /\[\[\s*react\s*[:：]\s*([^\]\n]{1,80}?)\s*\]\]/gi;
const CUSTOM = /^<a?:[\w~]{2,32}:\d{15,25}>$/;
// Unicode 表情：由表情符号、变体选择符、零宽连接符、肤色与旗帜区域符组成。
const UNICODE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\u20e3#*0-9])+$/u;
export const MAX_REACTIONS = 3;

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
  return { text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), reactions };
}

// 流式预览时去掉完整的标记以及结尾处尚未写完的半截标记。
export function stripReactionTags(text) {
  return String(text || '').replace(TAG, '').replace(/\[\[?(?:\s*r(?:e(?:a(?:c(?:t(?:\s*[:：][^\]\n]*)?)?)?)?)?)?$/i, '').trimEnd();
}
