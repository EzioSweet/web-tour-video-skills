/**
 * pronunciation.mjs — 发音词典、朗读文本校验、风险扫描。
 * 不依赖 TTS / 网络 / 浏览器。
 */

export function applyLexicon(text, lexicon = []) {
  if (!Array.isArray(lexicon)) throw new Error('lexicon 必须是数组');
  const entries = lexicon
    .filter((e) => e && typeof e.match === 'string' && e.match.length > 0)
    .map((e) => ({
      match: e.match,
      tts: String(e.tts ?? ''),
      note: e.note || '',
    }))
    .sort((a, b) => b.match.length - a.match.length);

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.match)) {
      throw new Error(`lexicon 中 match 重复：${e.match}`);
    }
    seen.add(e.match);
  }

  let out = '';
  let i = 0;
  const hits = [];
  while (i < text.length) {
    let found = null;
    for (const e of entries) {
      if (text.startsWith(e.match, i)) {
        found = e;
        break;
      }
    }
    if (found) {
      out += found.tts;
      hits.push({
        match: found.match,
        tts: found.tts,
        at: i,
        narrationContext: text.slice(Math.max(0, i - 12), i + found.match.length + 12),
      });
      i += found.match.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return { text: out, hits };
}

/** 某一步最终送给 TTS 的文本。tts_text 优先级最高，且不再套 lexicon。 */
export function resolveTtsText(step, lexicon = []) {
  if (typeof step?.tts_text === 'string' && step.tts_text.trim()) {
    return { text: step.tts_text, source: 'tts_text', hits: [] };
  }
  const narration = String(step?.narration ?? '');
  const applied = applyLexicon(narration, lexicon);
  return {
    text: applied.text,
    source: applied.hits.length ? 'lexicon' : 'narration',
    hits: applied.hits,
  };
}

// 常用拼音音节（不含声调）。用于区分“拼音注音”与 MP3 / API 之类的拉丁词。
const PINYIN_SYLLABLES = new Set(
  `a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
   ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong
   chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo
   da dai dan dang dao de dei deng di dia dian diao die ding diu dong dou du duan dui
   dun duo e ei en eng er fa fan fang fei fen feng fo fou fu ga gai gan gang gao ge
   gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he
   hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao
   jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke ken keng kong kou ku
   kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang
   liao lie lin ling liu long lou lu luan lun luo lv lve ma mai man mang mao me mei
   men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen
   neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve o ou pa pai
   pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang
   qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou
   ru rua ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao
   she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song
   sou su suan sui sun suo ta tai tan tang tao te teng ti tian tiao tie ting tong
   tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao
   xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you
   yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe
   zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong
   zou zu zuan zui zun zuo`.split(/\s+/),
);

/**
 * 校验最终朗读文本。
 * - 括号外不允许阿拉伯数字
 * - [ ... ] 内只允许大写字母、数字、空格（CMU 音素）
 * - 大写拼音 + 声调 1-4 必须是合法拼音音节
 * - ü（lv / nv）与轻声标记官方未验证，给出警告
 * - 其他拉丁词给出警告（英文词应使用 CMU）
 */
export function validateTtsText(text) {
  const errors = [];
  const warnings = [];
  const markers = [];

  const bracketRe = /\[([^\]]*)\]/g;
  for (const m of text.matchAll(bracketRe)) {
    const content = m[1];
    if (!/^[A-Z0-9 ]+$/.test(content)) {
      errors.push(`方括号内只能是大写 CMU 音素（大写字母/数字/空格），发现：[${content}]`);
    } else if (!/[0-9]/.test(content)) {
      warnings.push(`CMU 音素缺少重音数字，请确认：[${content}]`);
    }
    markers.push({ type: 'cmu', text: `[${content}]`, at: m.index });
  }

  const withoutBrackets = text.replace(bracketRe, ' ');
  const pinyinRe = /([A-Z]+)([1-4])/g;
  for (const m of withoutBrackets.matchAll(pinyinRe)) {
    const base = m[1];
    const lower = base.toLowerCase();
    if (PINYIN_SYLLABLES.has(lower)) {
      markers.push({ type: 'pinyin', text: m[0], at: m.index });
      if (lower.includes('v')) {
        warnings.push(`ü 写法（${m[0]}）官方示例未覆盖，本次未实测通过前不要用于正式旁白`);
      }
    } else {
      errors.push(
        `发现疑似非拼音的“大写字母+数字”：${m[0]}。数字必须转成汉字读法；英文请用 [CMU 音素]；多音字请用合法拼音+声调。`,
      );
    }
  }

  // 去掉拼音标记，再检查剩余数字。CMU 已去掉。
  const withoutPinyin = withoutBrackets.replace(pinyinRe, ' ');
  const digitMatches = withoutPinyin.match(/[0-9０-９]/g);
  if (digitMatches) {
    const idx = withoutPinyin.search(/[0-9０-９]/);
    errors.push(
      `朗读文本仍含阿拉伯数字“${digitMatches.join('')}”（附近：${withoutPinyin.slice(Math.max(0, idx - 10), idx + 12)}）。` +
        `请把数字写成汉字读法，例如 123 → 一百二十三、3.0 → 三点零、50% → 百分之五十、v2.1 → 二点一版本。`,
    );
  }

  const latinTokens = withoutPinyin.match(/[A-Za-z][A-Za-z0-9'’._+-]*/g) || [];
  for (const token of [...new Set(latinTokens)]) {
    // 汉字拼音标记已被移除；剩下的拉丁词通常是英文单词/品牌/缩写。
    warnings.push(`含拉丁字母词“${token}”：英文发音请改用 [CMU 音素]，品牌名建议先试听或改写。`);
  }

  // 中文里夹着无音调的大写字母，很可能被逐字母读。
  const bareUpper = withoutPinyin.match(/(?<=[\u3400-\u9fff])[A-Z]{2,}(?=[\u3400-\u9fff]|$)/g) || [];
  for (const token of [...new Set(bareUpper)]) {
    warnings.push(`“${token}”紧贴汉字但没有声调数字，可能被逐字母朗读；若不是有意为之，请加合法拼音声调或改写。`);
  }

  return { ok: errors.length === 0, errors, warnings, markers };
}

// ---------------------------------------------------------------------------
// 风险词表 / 扫描
// ---------------------------------------------------------------------------

const RISK_TERMS = [
  { word: '重要', tts: 'ZHONG4要', kind: '多音字' },
  { word: '重启', tts: 'CHONG2启', kind: '多音字' },
  { word: '重新', tts: 'CHONG2新', kind: '多音字' },
  { word: '重复', tts: 'CHONG2复', kind: '多音字' },
  { word: '行业', tts: 'HANG2业', kind: '多音字' },
  { word: '银行', tts: '银HANG2', kind: '多音字' },
  { word: '音乐', tts: '音YUE4', kind: '多音字' },
  { word: '快乐', tts: '快LE4', kind: '多音字' },
  { word: '长城', tts: 'CHANG2城', kind: '多音字' },
  { word: '长大', tts: 'ZHANG3大', kind: '多音字' },
  { word: '还有', tts: 'HAI2有', kind: '多音字' },
  { word: '归还', tts: '归HUAN2', kind: '多音字' },
  { word: '都市', tts: 'DU1市', kind: '多音字' },
  { word: '首都', tts: '首DU1', kind: '多音字' },
  { word: '得到', tts: 'DE2到', kind: '多音字' },
  { word: '觉得', tts: 'JUE2得', kind: '多音字' },
  { word: '睡觉', tts: '睡JIAO4', kind: '多音字' },
  { word: '了解', tts: 'LIAO3解', kind: '多音字' },
  { word: '着急', tts: 'ZHAO2急', kind: '多音字' },
  { word: '差别', tts: 'CHA1别', kind: '多音字' },
  { word: '出差', tts: '出CHAI1', kind: '多音字' },
  { word: '参加', tts: 'CAN1加', kind: '多音字' },
  { word: '人参', tts: '人SHEN1', kind: '多音字' },
  { word: '单身', tts: 'DAN1身', kind: '多音字' },
  { word: '简单', tts: '简DAN1', kind: '多音字' },
  { word: '调查', tts: 'DIAO4查', kind: '多音字' },
  { word: '空调', tts: '空TIAO2', kind: '多音字' },
  { word: '发现', tts: 'FA1现', kind: '多音字' },
  { word: '干活', tts: 'GAN4活', kind: '多音字' },
  { word: '干净', tts: 'GAN1净', kind: '多音字' },
  { word: '更加', tts: 'GENG4加', kind: '多音字' },
  { word: '更新', tts: 'GENG1新', kind: '多音字' },
  { word: '好人', tts: 'HAO3人', kind: '多音字' },
  { word: '爱好', tts: '爱HAO4', kind: '多音字' },
  { word: '和平', tts: 'HE2平', kind: '多音字' },
  { word: '几个', tts: 'JI3个', kind: '多音字' },
  { word: '几乎', tts: 'JI1乎', kind: '多音字' },
  { word: '假期', tts: 'JIA4期', kind: '多音字' },
  { word: '真假', tts: '真JIA3', kind: '多音字' },
  { word: '间隔', tts: 'JIAN4隔', kind: '多音字' },
  { word: '中间', tts: '中JIAN1', kind: '多音字' },
  { word: '将来', tts: 'JIANG1来', kind: '多音字' },
  { word: '将军', tts: 'JIANG1军', kind: '多音字' },
  { word: '教书', tts: 'JIAO1书', kind: '多音字' },
  { word: '教育', tts: 'JIAO4育', kind: '多音字' },
  { word: '结束', tts: 'JIE2束', kind: '多音字' },
  { word: '解决', tts: 'JIE3决', kind: '多音字' },
  { word: '看见', tts: 'KAN4见', kind: '多音字' },
  { word: '看守', tts: 'KAN1守', kind: '多音字' },
  { word: '天空', tts: '天KONG1', kind: '多音字' },
  { word: '空白', tts: 'KONG4白', kind: '多音字' },
  { word: '落后', tts: 'LUO4后', kind: '多音字' },
  { word: '丢三落四', tts: '丢三LA4四', kind: '多音字' },
  { word: '难过', tts: 'NAN2过', kind: '多音字' },
  { word: '宁可', tts: 'NING4可', kind: '多音字' },
  { word: '强大', tts: 'QIANG2大', kind: '多音字' },
  { word: '勉强', tts: '勉QIANG3', kind: '多音字' },
  { word: '歌曲', tts: '歌QU3', kind: '多音字' },
  { word: '弯曲', tts: '弯QU1', kind: '多音字' },
  { word: '少数', tts: 'SHAO3数', kind: '多音字' },
  { word: '数学', tts: 'SHU4学', kind: '多音字' },
  { word: '数数', tts: 'SHU3数', kind: '多音字' },
  { word: '说话', tts: 'SHUO1话', kind: '多音字' },
  { word: '说服', tts: 'SHUO1服', kind: '多音字' },
  { word: '收缩', tts: 'SHOU1缩', kind: '多音字' },
  { word: '弹琴', tts: 'TAN2琴', kind: '多音字' },
  { word: '子弹', tts: '子DAN4', kind: '多音字' },
  { word: '挑战', tts: 'TIAO3战', kind: '多音字' },
  { word: '挑选', tts: 'TIAO1选', kind: '多音字' },
  { word: '因为', tts: 'YIN1为', kind: '多音字' },
  { word: '相信', tts: 'XIANG1信', kind: '多音字' },
  { word: '相貌', tts: 'XIANG4貌', kind: '多音字' },
  { word: '高兴', tts: 'GAO1兴', kind: '多音字' },
  { word: '兴趣', tts: 'XING4趣', kind: '多音字' },
  { word: '血液', tts: 'XUE4液', kind: '多音字' },
  { word: '应该', tts: 'YING1该', kind: '多音字' },
  { word: '参与', tts: 'CAN1与', kind: '多音字' },
  { word: '载重', tts: 'ZAI4重', kind: '多音字' },
  { word: '记载', tts: '记ZAI3', kind: '多音字' },
  { word: '择菜', tts: 'ZHAI2菜', kind: '多音字' },
  { word: '正在', tts: 'ZHENG4在', kind: '多音字' },
  { word: '只有', tts: 'ZHI3有', kind: '多音字' },
  { word: '一只', tts: '一ZHI1', kind: '多音字' },
  { word: '种子', tts: 'ZHONG3子', kind: '多音字' },
  { word: '种植', tts: 'ZHONG4植', kind: '多音字' },
  { word: '转身', tts: 'ZHUAN3身', kind: '多音字' },
  { word: '转动', tts: 'ZHUAN4动', kind: '多音字' },
  { word: '作业', tts: 'ZUO4业', kind: '多音字' },
  { word: '处理', tts: 'CHU3理', kind: '多音字' },
  { word: '到处', tts: 'DAO4处', kind: '多音字' },
  { word: '传说', tts: 'CHUAN2说', kind: '多音字' },
  { word: '传记', tts: 'ZHUAN4记', kind: '多音字' },
  { word: '回答', tts: 'HUI2答', kind: '多音字' },
  { word: '当然', tts: 'DANG1然', kind: '多音字' },
  { word: '当铺', tts: 'DANG4铺', kind: '多音字' },
  { word: '倒车', tts: 'DAO4车', kind: '多音字' },
  { word: '打倒', tts: '打DAO3', kind: '多音字' },
  { word: '目的', tts: '目DI4', kind: '多音字' },
  { word: '的确', tts: 'DI2确', kind: '多音字' },
  { word: '提高', tts: 'TI2高', kind: '多音字' },
  { word: '温度', tts: '温DU4', kind: '多音字' },
  { word: '度过', tts: 'DU4过', kind: '多音字' },
  { word: '恶心', tts: 'E3心', kind: '多音字' },
  { word: '厌恶', tts: '厌WU4', kind: '多音字' },
  { word: '分数', tts: 'FEN1数', kind: '多音字' },
  { word: '分外', tts: 'FEN4外', kind: '多音字' },
  { word: '缝补', tts: 'FENG2补', kind: '多音字' },
  { word: '缝隙', tts: 'FENG4隙', kind: '多音字' },
  { word: '供给', tts: 'GONG1给', kind: '多音字' },
  { word: '提供', tts: 'TI2供', kind: '多音字' },
  { word: '冠军', tts: 'GUAN4军', kind: '多音字' },
  { word: '皇冠', tts: '皇GUAN1', kind: '多音字' },
  { word: '号码', tts: 'HAO4码', kind: '多音字' },
  { word: '号召', tts: 'HAO4召', kind: '多音字' },
  { word: '喝水', tts: 'HE1水', kind: '多音字' },
  { word: '喝彩', tts: 'HE4彩', kind: '多音字' },
  { word: '横竖', tts: 'HENG2竖', kind: '多音字' },
  { word: '蛮横', tts: '蛮HENG4', kind: '多音字' },
  { word: '华丽', tts: 'HUA2丽', kind: '多音字' },
  { word: '华山', tts: 'HUA4山', kind: '多音字' },
  { word: '计划', tts: 'JI4划', kind: '多音字' },
  { word: '划算', tts: 'HUA2算', kind: '多音字' },
  { word: '奇怪', tts: 'QI2怪', kind: '多音字' },
  { word: '奇数', tts: 'JI1数', kind: '多音字' },
  { word: '联系', tts: '联XI4系', kind: '多音字' },
  { word: '夹子', tts: 'JIA1子', kind: '多音字' },
  { word: '夹袄', tts: 'JIA2袄', kind: '多音字' },
  { word: '劲头', tts: 'JIN4头', kind: '多音字' },
  { word: '强劲', tts: '强JING4', kind: '多音字' },
  { word: '卷起', tts: 'JUAN3起', kind: '多音字' },
  { word: '试卷', tts: '试JUAN4', kind: '多音字' },
  { word: '积累', tts: '积LEI3', kind: '多音字' },
  { word: '数量', tts: 'SHU4量', kind: '多音字' },
  { word: '力量', tts: '力LIANG4', kind: '多音字' },
  { word: '论据', tts: 'LUN4据', kind: '多音字' },
  { word: '论语', tts: 'LUN2语', kind: '多音字' },
  { word: '没有', tts: 'MEI2有', kind: '多音字' },
  { word: '淹没', tts: '淹MO4', kind: '多音字' },
  { word: '模型', tts: 'MO2型', kind: '多音字' },
  { word: '模样', tts: 'MU2样', kind: '多音字' },
  { word: '那里', tts: 'NA4里', kind: '多音字' },
  { word: '刹那', tts: 'CHA4那', kind: '多音字' },
  { word: '泡茶', tts: 'PAO4茶', kind: '多音字' },
  { word: '泡沫', tts: 'PAO4沫', kind: '多音字' },
  { word: '铺床', tts: 'PU1床', kind: '多音字' },
  { word: '店铺', tts: '店PU4', kind: '多音字' },
  { word: '期待', tts: 'QI1待', kind: '多音字' },
  { word: '学期', tts: '学QI1', kind: '多音字' },
  { word: '散步', tts: 'SAN4步', kind: '多音字' },
  { word: '散漫', tts: 'SAN3漫', kind: '多音字' },
  { word: '扫地', tts: 'SAO3地', kind: '多音字' },
  { word: '舍弃', tts: 'SHE3弃', kind: '多音字' },
  { word: '宿舍', tts: 'SU4舍', kind: '多音字' },
  { word: '盛开', tts: 'SHENG4开', kind: '多音字' },
  { word: '盛饭', tts: 'CHENG2饭', kind: '多音字' },
  { word: '属于', tts: 'SHU3于', kind: '多音字' },
  { word: '相似', tts: 'XIANG1似', kind: '多音字' },
  { word: '填写', tts: 'TIAN2写', kind: '多音字' },
  { word: '吐出', tts: 'TU3出', kind: '多音字' },
  { word: '吞吐', tts: 'TUN1吐', kind: '多音字' },
  { word: '囤积', tts: 'TUN2积', kind: '多音字' },
  { word: '瓦片', tts: 'WA3片', kind: '多音字' },
  { word: '尾巴', tts: 'WEI3巴', kind: '多音字' },
  { word: '文章', tts: 'WEN2章', kind: '多音字' },
  { word: '关系', tts: '关XI4系', kind: '多音字' },
  { word: '恐吓', tts: '恐HE4', kind: '多音字' },
  { word: '新鲜', tts: 'XIN1鲜', kind: '多音字' },
  { word: '朝鲜', tts: '朝XIAN3鲜', kind: '多音字' },
  { word: '肖像', tts: 'XIAO4像', kind: '多音字' },
  { word: '学校', tts: '学XIAO4', kind: '多音字' },
  { word: '校对', tts: 'JIAO4对', kind: '多音字' },
  { word: '芯片', tts: 'XIN1片', kind: '多音字' },
  { word: '行走', tts: 'XING2走', kind: '多音字' },
  { word: '省悟', tts: 'XING3悟', kind: '多音字' },
  { word: '反省', tts: '反XING3', kind: '多音字' },
  { word: '盘旋', tts: '盘XUAN2', kind: '多音字' },
  { word: '旋风', tts: 'XUAN4风', kind: '多音字' },
  { word: '押解', tts: '押JIE4', kind: '多音字' },
  { word: '咽喉', tts: 'YAN1喉', kind: '多音字' },
  { word: '咽下', tts: 'YAN4下', kind: '多音字' },
  { word: '要求', tts: 'YAO1求', kind: '多音字' },
  { word: '叶子', tts: 'YE4子', kind: '多音字' },
  { word: '应用', tts: 'YING4用', kind: '多音字' },
  { word: '佣金', tts: 'YONG4金', kind: '多音字' },
  { word: '佣人', tts: 'YONG1人', kind: '多音字' },
  { word: '柚子', tts: 'YOU4子', kind: '多音字' },
  { word: '圆润', tts: 'YUAN2润', kind: '多音字' },
  { word: '晕倒', tts: 'YUN1倒', kind: '多音字' },
  { word: '晕车', tts: 'YUN4车', kind: '多音字' },
  { word: '扎针', tts: 'ZHA1针', kind: '多音字' },
  { word: '挣扎', tts: '挣ZHA2', kind: '多音字' },
  { word: '粘贴', tts: 'ZHAN1贴', kind: '多音字' },
  { word: '涨价', tts: 'ZHANG3价', kind: '多音字' },
  { word: '膨胀', tts: '膨ZHANG4', kind: '多音字' },
  { word: '症状', tts: 'ZHENG4状', kind: '多音字' },
  { word: '症结', tts: 'ZHENG1结', kind: '多音字' },
  { word: '挣钱', tts: 'ZHENG4钱', kind: '多音字' },
  { word: '挣脱', tts: 'ZHENG4脱', kind: '多音字' },
  { word: '正月', tts: 'ZHENG1月', kind: '多音字' },
  { word: '正确', tts: 'ZHENG4确', kind: '多音字' },
  { word: '殖民', tts: 'ZHI2民', kind: '多音字' },
  { word: '轴承', tts: 'ZHOU2承', kind: '多音字' },
  { word: '看着', tts: null, kind: '多音字', advice: '“着”读轻声，官方示例未覆盖，建议改写为“观看”' },
  { word: '为了', tts: null, kind: '多音字', advice: '“了”读轻声，官方示例未覆盖，建议改写措辞' },
  { word: '头发', tts: null, kind: '多音字', advice: '“发”读轻声，官方示例未覆盖，建议改写措辞' },
  { word: '豆腐', tts: null, kind: '多音字', advice: '“腐”读轻声，官方示例未覆盖，建议改写措辞' },
  { word: '朋友', tts: null, kind: '多音字', advice: '“友”读轻声，官方示例未覆盖，建议改写措辞' },
];

const RARE_CHARS = new Set(
  '龘靐齉爨彧珩玥祎晟煜睿萱梓轩昊淼焱垚犇骉羴鱻麤鑫喆瑄璟璐'.split(''),
);

const TERM_WORDS = [
  { word: '埋点', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '转化率', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '完播率', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '留存率', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '日活', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '月活', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '客单价', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '漏斗', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '私域', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '公域', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '增长黑客', kind: '专业术语', advice: '确认术语读音；必要时改写' },
  { word: '飞书', kind: '品牌名', advice: '品牌名建议先试听或改写' },
  { word: '钉钉', kind: '品牌名', advice: '品牌名建议先试听或改写' },
  { word: '企业微信', kind: '品牌名', advice: '品牌名建议先试听或改写' },
  { word: '视频号', kind: '品牌名', advice: '品牌名建议先试听或改写' },
  { word: '小程序', kind: '产品名', advice: '确认读音；必要时改写' },
];

function findTermOccurrences(text, terms) {
  const matches = [];
  for (const term of terms) {
    let from = 0;
    while (from <= text.length - term.word.length) {
      const at = text.indexOf(term.word, from);
      if (at < 0) break;
      matches.push({ ...term, at, end: at + term.word.length });
      from = at + term.word.length;
    }
  }
  matches.sort((a, b) => a.at - b.at || b.word.length - a.word.length);
  const selected = [];
  for (const m of matches) {
    if (selected.some((s) => m.at < s.end && m.end > s.at)) continue;
    selected.push(m);
  }
  return selected;
}

export function scanNarrationRisks(narration, { hits, hasTtsText }) {
  const items = [];
  const add = (item) => items.push(item);

  for (const term of findTermOccurrences(narration, [...RISK_TERMS, ...TERM_WORDS])) {
    add({
      kind: term.kind,
      text: term.word,
      at: term.at,
      end: term.end,
      context: narration.slice(Math.max(0, term.at - 10), term.end + 10),
      suggestion: term.tts
        ? `{"match":"${term.word}","tts":"${term.tts}"}`
        : term.advice || '建议改写措辞',
      hasTtsText,
      hits,
    });
  }

  for (const m of narration.matchAll(/\d+(?:[.,]\d+)?\s*%?/g)) {
    add({
      kind: '阿拉伯数字',
      text: m[0].trim(),
      at: m.index,
      end: m.index + m[0].length,
      context: narration.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10),
      suggestion: '在 tts_text 中写成汉字读法（如 3 → 三、50% → 百分之五十）',
      hasTtsText,
      hits,
    });
  }

  for (const m of narration.matchAll(/[A-Za-z][A-Za-z0-9+&._/-]*/g)) {
    add({
      kind: '英文/缩写',
      text: m[0],
      at: m.index,
      end: m.index + m[0].length,
      context: narration.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10),
      suggestion: '英文用 [CMU 音素]；品牌/缩写建议改写或先试听',
      hasTtsText,
      hits,
    });
  }

  for (let i = 0; i < narration.length; i += 1) {
    const ch = narration[i];
    const isExt = /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/u.test(ch);
    if (isExt || RARE_CHARS.has(ch)) {
      add({
        kind: '生僻字',
        text: ch,
        at: i,
        end: i + 1,
        context: narration.slice(Math.max(0, i - 10), i + 11),
        suggestion: '确认读音；必要时用拼音注音或改写',
        hasTtsText,
        hits,
      });
    }
  }

  items.sort((a, b) => a.at - b.at);
  return items.map((item) => {
    if (hasTtsText) {
      return { ...item, handled: 'tts_text', handling: '手写 tts_text 已覆盖（请核对朗读文本）' };
    }
    const hit = hits.find((h) => item.at < h.at + h.match.length && item.end > h.at);
    if (hit) {
      return { ...item, handled: 'lexicon', handling: `lexicon：${hit.match} → ${hit.tts}` };
    }
    return { ...item, handled: 'none', handling: '未处理，需要处理' };
  });
}

// ---------------------------------------------------------------------------
// 鼠标覆盖层 / 页面动作
