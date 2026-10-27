// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The films' own words in other languages. FILM_LANG=zh renders the stacked
 * film and the trailer with Simplified Chinese captions, labels and end card
 * (the app's screens, as recorded, stay as they are), into "-zh" files beside
 * the English ones. Every line the films draw needs an entry here: a missing
 * one stops the film instead of slipping through in English.
 */
export const FILM_LANG = process.env.FILM_LANG ?? 'en';
/** Output and work-folder suffix: '' for English, '-zh' for Chinese. */
export const LANG_SUFFIX = FILM_LANG === 'en' ? '' : `-${FILM_LANG}`;
/** The lang attribute of the pages the overlays are drawn in. */
export const HTML_LANG = FILM_LANG === 'zh' ? 'zh-CN' : 'en';

const ZH = {
  // Terms of the trade (robotics, XR, the app's own buttons) stay in English, as
  // Chinese-speaking engineers say them: REAL -> SIM -> REAL, Scene Understanding,
  // Depth Sensing, Mixed Reality, test case, MuJoCo, IWER, TRY IT, Wi-Fi.
  // The trailer (compose-trailer.mjs)
  'Robots learn to walk in simulation...': '机器人在仿真中学会了走路……',
  '...then a real home trips them up.': '……可一到真实的家里就频频摔倒。',
  'Put on a headset: the simulation runs in your real room': '戴上头显，仿真就在你真实的房间里运行',
  'Your real furniture becomes solid: Pip walks into the chair': '真实家具变成了实体：Pip 一头撞上了椅子',
  'It steps onto the dog bed, and falls off, as a real robot would': '它走上狗窝又摔了下来，就像真的机器人一样',
  'A stumble becomes a test case, sent straight to your computer': '每一次摔跤都会变成一个 test case，直接发到你的电脑上',
  'Then the same brain runs on the real robot': '然后，同一个大脑直接跑在真机器人上',
  'CONCEPT ANIMATION': '概念动画',
  'SHOT ON META QUEST 3': 'META QUEST 3 实拍',
  'THE REAL APP, RECORDED': '真实 App 录屏',
  'SCENE UNDERSTANDING + DEPTH SENSING': 'SCENE UNDERSTANDING + DEPTH SENSING',
  REAL: 'REAL',
  SIM: 'SIM',
  'Your real room, inside the simulation': '把你的真实房间搬进仿真',
  'IN SIMULATION': '仿真环境',
  'AT HOME': '真实家中',
  'Train your robot in your own room': '在自己的房间里训练你的机器人',
  'Developed by Bruna Worlds': '由 Bruna Worlds 开发',
  'Microduck model and walking AI (c) Pollen Robotics. Unofficial fan project, not made or endorsed by Pollen Robotics. Music: original, made for this film.':
    'Microduck 模型与行走 AI (c) Pollen Robotics。非官方粉丝项目，并非由 Pollen Robotics 制作或认可。音乐为本片原创。',
  '(c) 2026 BRUNA GOODS LLC. All rights reserved.': '(c) 2026 BRUNA GOODS LLC。保留所有权利。',
  // The stacked film (compose-stack.mjs): its labels, then the captions stack.sh marks
  'HEADSET AND COMPUTER, LINKED OVER WI-FI': '头显与电脑通过 WI-FI 互联',
  HEADSET: '头显',
  'mixed reality, emulated (IWER)': 'Mixed Reality，IWER 模拟器',
  'YOUR COMPUTER': '你的电脑',
  'Duck Lab XR trainer, in the browser': '浏览器里的 Duck Lab XR 训练器',
  'Pip walks your living room, in mixed reality': 'Pip 在 Mixed Reality 里逛你的客厅',
  "Live robot data: every joint, the balance sensor and the brain's output": '实时机器人数据：每个关节、平衡传感器，以及大脑的输出',
  'A hard moment? One tap saves it as a test case': '遇到难关？一键存为 test case',
  'On the computer a moment later, over your Wi-Fi': '转眼间，它就通过 Wi-Fi 传到了电脑上',
  'Replay a hard one in MuJoCo: the shipped brain falls here': '在 MuJoCo 里回放这一幕：原版大脑在这里摔倒了',
  'Train on your computer: copies of the brain practise that moment': '在电脑上训练：多个大脑副本反复练习这一刻',
  'A brain trained on these moments: falls 42% to 4%. Send it to the headset': '针对这些时刻训练出的大脑：摔倒率从 42% 降到 4%，发送到头显',
  'The new brain is on the headset: TRY IT': '新大脑已到头显：点 TRY IT 试试',
  'Pip walks with the brain trained on your room, round the books': 'Pip 换上专为你家训练的大脑，绕开书堆前进',
};
const TABLES = { zh: ZH };

/** The line in the film's language; English passes through. */
export function tr(text) {
  if (FILM_LANG === 'en') return text;
  const table = TABLES[FILM_LANG];
  if (!table) throw new Error(`FILM_LANG=${FILM_LANG}: unknown language (en, zh)`);
  const out = table[text];
  if (out === undefined) throw new Error(`FILM_LANG=${FILM_LANG}: no translation for "${text}" (tools/film/lang.mjs)`);
  // English terms inside a Chinese line (test case, Mixed Reality, TRY IT) never break apart.
  return out.replace(/([A-Za-z0-9]) (?=[A-Za-z0-9])/g, '$1 ');
}

/** The fast-forward badge's words for a speed-up of v. */
export const speedLabel = (v) => (FILM_LANG === 'zh' ? `${v} 倍速` : `${v}× FASTER`);

/**
 * The overlay pages' CSS for this language. Chinese glyphs come from
 * Microsoft YaHei (then other common CJK faces): after every 'Segoe UI',
 * and as a second face of the Bebas display family for CJK code points, so
 * every label that uses Bebas gets them without naming another font.
 */
export function filmCss(css) {
  if (FILM_LANG === 'en') return css;
  const cjk = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC'";
  const ranges = 'U+2E80-2FDF, U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF';
  // Chinese lines break at punctuation and spaces only (not inside a word such as 一模一样),
  // anywhere as a last resort, and wrapped lines come out about even.
  return `${css.replaceAll("'Segoe UI',", `'Segoe UI', ${cjk},`)}
@font-face { font-family: Bebas; src: local('Microsoft YaHei Bold'), local('Microsoft YaHei'), local('PingFang SC'); unicode-range: ${ranges}; }
.cap div, .band .text, .end .line, .end .small, .qflow .s { word-break: keep-all; overflow-wrap: anywhere; text-wrap: balance; }`;
}
