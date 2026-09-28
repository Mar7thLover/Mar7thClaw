// 打印角色卡组装出的 system 层与本轮注入层，便于调试提示词（相当于酒馆的 Prompt Inspector）。
// 用法：npm run preview -- "要测试的消息" [panel|discord_dm|discord_group] [owner|guest]
import path from 'node:path';
import { loadConfig, root, dataDir } from '../src/config.js';
import { CardStore } from '../src/persona/card.js';
import { assemblePrompt } from '../src/persona/assembler.js';

const [text = '三月，帮我整理一下桌面上的照片', surface = 'panel', tier = 'owner'] = process.argv.slice(2);
const config = loadConfig();
const cards = new CardStore([path.join(dataDir, 'cards'), path.join(root, 'cards')]);
const card = cards.get(config.card);
const result = assemblePrompt({
  card, prompt: config.prompt, userName: config.user.name, persona: config.user.persona, surface, tier,
  authorNote: '', recent: [], message: { from: config.user.name, text, via: surface, time: new Date().toLocaleString('zh-CN', { hour12: false }) },
  greeting: card.data.first_mes,
});
console.log('===== system 层（--append-system-prompt-file）=====\n');
console.log(result.system);
console.log('\n===== 本轮注入层（stdin 用户消息）=====\n');
console.log(result.turn);
console.log('\n===== 激活的世界书条目 =====');
for (const entry of result.activated) console.log(`- ${entry.name}（${entry.reason}）`);
console.log(`\nsystem 层 ${result.system.length} 字符，注入层 ${result.turn.length} 字符`);
