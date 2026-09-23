// 解析逻辑模拟测试：把 content.js 注入 vm，导出内部 parseMessage/state 做行为验证
// 运行：node test/simulate.js
// 消息格式依据 colonist.io 前端 bundle 与 en_strings.json 中的真实模板：
//   垄断结果: "{{playerName}} stole {{amountStolen}} {{cardString}}" —— 纯文本无图片、无 from
//   使用发展卡: "{{playerName}} used <a href='{{url}}'> {{content}} {{cardImage}} </a>"
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const contentPath = process.argv[2] || path.join(__dirname, '..', 'content.js');
let src = fs.readFileSync(contentPath, 'utf8');

// 在 IIFE 末尾插入导出钩子（仅测试用，不改源文件）
src = src.replace(/\}\)\(\);\s*$/, "globalThis.__catan = { state, parseMessage };})();");

// DOM / 浏览器环境桩
const noop = () => {};
const fakeEl = () => ({ remove: noop, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, getAttribute: () => null, appendChild: noop, attachShadow: () => ({ appendChild: noop }), style: {}, classList: { includes: () => false } });
const sandbox = {
  console,
  document: {
    documentElement: fakeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => fakeEl(),
    body: fakeEl(),
  },
  MutationObserver: class { constructor() {} observe() {} },
  ResizeObserver: class { constructor() {} observe() {} },
  localStorage: { getItem: () => null, setItem: noop },
  window: { addEventListener: noop },
  setInterval: () => 0,
  clearInterval: noop,
  setTimeout: () => 0,
  globalThis: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const { state, parseMessage } = sandbox.__catan;

// 初始化 3 名玩家（我是 Me）
state.myUsername = 'Me';
for (const n of ['Alice', 'Bob', 'Me']) {
  state.players.set(n, (() => {
    const resources = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
    return { resources, devCards: 0, unknownResources: 0, avatar: '', vp: 0, army: 0, road: 0, color: '', active: false, domRow: null };
  })());
  state.playerOrder.push(n);
}

function msg(playerName, text, html) {
  parseMessage(playerName, text, html ?? text.replace(/^(\S+)/, '<span style="font-weight:600">$1</span>'));
}
function totals(name) {
  const p = state.players.get(name);
  const known = Object.values(p.resources).reduce((a, b) => a + b, 0);
  return { ...p.resources, unknown: p.unknownResources, total: known + p.unknownResources, dev: p.devCards };
}
function reset() {
  for (const [, p] of state.players) {
    for (const r of Object.keys(p.resources)) p.resources[r] = 0;
    p.unknownResources = 0; p.devCards = 0;
  }
}
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label);
  if (!ok) { console.log('   actual  :', JSON.stringify(actual)); console.log('   expected:', JSON.stringify(expected)); fail++; }
  else pass++;
}

const IMG = {
  lumber: 'https://cdn.colonist.io/dist/assets/card_lumber.cf22f8083cf89c2a29e7.svg',
  brick: 'https://cdn.colonist.io/dist/assets/card_brick.5950ea07a7ea01bc54a5.svg',
  wool: 'https://cdn.colonist.io/dist/assets/card_wool.17a6dea8d559949f0ccc.svg',
  grain: 'https://cdn.colonist.io/dist/assets/card_grain.09c9d82146a64bce69b5.svg',
  ore: 'https://cdn.colonist.io/dist/assets/card_ore.117f64dab28e1c987958.svg',
  back: 'https://cdn.colonist.io/dist/assets/card_rescardback.03c18312a76028b0d9c9.svg',
  devback: 'https://cdn.colonist.io/dist/assets/card_devcardback.92569a1abd04a8c1c17e.svg',
  monopoly: 'https://cdn.colonist.io/dist/assets/card_monopoly.dfac189aaff62e271093.svg',
};
const img = (k) => `<img src="${IMG[k]}">`;
const nameSpan = (n) => `<span style="font-weight:600">${n}</span>`;

// ---------- 场景 1：正常垄断（Alice 垄断 4 Ore） ----------
console.log('\n=== 场景 1: Alice bought dev card → used Monopoly → stole 4 Ore ===');
reset();
msg('Bob', 'Bob got 2 starting resources', `${nameSpan('Bob')} got ${img('ore')}${img('ore')}`);
msg('Alice', 'Alice bought a development card', `${nameSpan('Alice')} bought a ${img('devback')}`);
msg('Alice', 'Alice used Monopoly', `${nameSpan('Alice')} used <a href="#card-description-popup-13"> Monopoly ${img('monopoly')} </a>`);
msg('Alice', 'Alice stole 4 Ore', `${nameSpan('Alice')} stole 4 Ore`);
check('Alice devCards', totals('Alice').dev, 0);
check('Alice ore', totals('Alice').ore, 4);
check('Bob ore zeroed', totals('Bob').ore, 0);
check('Bob total', totals('Bob').total, 0);

// ---------- 场景 2：玩家名 Corey 含 'ore' ----------
console.log('\n=== 场景 2: 玩家 Corey（名字含 ore）使用 Monopoly on Grain ===');
reset();
state.players.set('Corey', state.players.get('Alice')); state.players.delete('Alice');
state.playerOrder.length = 0; state.playerOrder.push('Corey', 'Bob', 'Me');
msg('Bob', 'Bob got resources', `${nameSpan('Bob')} got ${img('ore')}${img('wool')}`);
msg('Corey', 'Corey used Monopoly', `${nameSpan('Corey')} used <a href="#card-description-popup-13"> Monopoly ${img('monopoly')} </a>`);
msg('Corey', 'Corey stole 3 Grain', `${nameSpan('Corey')} stole 3 Grain`);
check('Corey grain', totals('Corey').grain, 3);
check('Corey ore (不应被加)', totals('Corey').ore, 0);
check('Bob ore (不应被清零——垄断的是 Grain)', totals('Bob').ore, 1);
check('Bob wool (不应受影响)', totals('Bob').wool, 1);

// ---------- 场景 3：玩家 Woolly 垄断 Ore（名字含 wool） ----------
console.log('\n=== 场景 3: 玩家 Woolly（名字含 wool）stole 4 Ore ===');
reset();
state.players.set('Woolly', state.players.get('Corey')); state.players.delete('Corey');
state.playerOrder.length = 0; state.playerOrder.push('Woolly', 'Bob', 'Me');
msg('Woolly', 'Woolly used Monopoly', `${nameSpan('Woolly')} used <a href="#card-description-popup-13"> Monopoly ${img('monopoly')} </a>`);
msg('Woolly', 'Woolly stole 4 Ore', `${nameSpan('Woolly')} stole 4 Ore`);
check('Woolly ore', totals('Woolly').ore, 4);
check('Woolly wool (不应被加)', totals('Woolly').wool, 0);

// ---------- 场景 4：回归——普通抢劫偷卡（带 from，卡背图） ----------
console.log('\n=== 场景 4: 回归——Alice stole [card back] from Bob（未知偷卡） ===');
reset();
state.players.set('Alice', state.players.get('Woolly')); state.players.delete('Woolly');
state.playerOrder.length = 0; state.playerOrder.push('Alice', 'Bob', 'Me');
msg('Bob', 'Bob got resources', `${nameSpan('Bob')} got ${img('ore')}${img('ore')}${img('wool')}`);
msg('Alice', 'Alice stole from Bob', `${nameSpan('Alice')} stole ${img('back')} from ${nameSpan('Bob')}`);
check('Bob 被偷后 total', totals('Bob').total, 2);
check('Alice unknown +1', totals('Alice').unknown, 1);

// ---------- 场景 5：回归——已知类型偷卡（我偷别人，显示资源图） ----------
console.log('\n=== 场景 5: 回归——You stole [ore] from Bob（已知偷卡） ===');
msg('You', 'You stole from Bob', `${nameSpan('You')} stole ${img('ore')} from ${nameSpan('Bob')}`);
check('Bob ore 减到 0（2 ore 先后被未知/已知各偷 1 张）', totals('Bob').ore, 0);
check('Bob 剩余 total = 1（剩 1 wool，以 unknown 形式）', totals('Bob').total, 1);

// ---------- 场景 6：垄断 0 张 ----------
console.log('\n=== 场景 6: Alice stole 0 Wool（垄断 0 张） ===');
msg('Alice', 'Alice stole 0 Wool', `${nameSpan('Alice')} stole 0 Wool`);
check('Alice wool', totals('Alice').wool, 0);
check('Bob wool 被清零', totals('Bob').wool, 0);

console.log('\n结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
