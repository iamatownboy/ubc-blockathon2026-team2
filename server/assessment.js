// Missions, fixed grading, and the filtered coach.
//
// Two different systems, deliberately:
//   • The COACH helps the learner. It rewrites their phrasing and explains
//     why, in their own language. Its response passes through an allowlist
//     of four fields — corrections, explanation, encouragement, language —
//     so nothing it says can reach the ledger. The offline coach returns
//     pass: true and credits: 999999 on purpose, so a test can prove the
//     filter strips them.
//   • The VERIFIER pays the learner. Fixed multiple-choice and
//     required-phrase criteria decide pass or fail. Nothing the coach
//     returned is consulted here.
"use strict";

const path = require("path");
const { bytes32, hashParts } = require("./ids");

// ---------------------------------------------------------------- missions

const MISSION_VERSION = 1;
const DEFAULT_REWARD = 100; // = CAD 5.00

const t = (en, ko, zh) => ({ en, ko, zh });

function mission(def) {
  return {
    ...def,
    missionId: bytes32(`mission:${def.slug}`),
    version: def.version ?? MISSION_VERSION,
    reward: def.reward ?? DEFAULT_REWARD,
  };
}

const MISSIONS = [
  mission({
    slug: "library-conversation-group",
    icon: "📚",
    minutes: 3,
    title: t(
      "Ask about the library's English conversation group",
      "도서관 영어 회화 모임에 대해 물어보기",
      "询问图书馆的英语会话小组"
    ),
    place: t("Vancouver Public Library, front desk", "밴쿠버 공립도서관 안내데스크", "温哥华公共图书馆 服务台"),
    scenario: t(
      "Your branch library runs a free English conversation group. You walk up to the front desk to ask about it and sign up.",
      "동네 도서관에서 무료 영어 회화 모임을 운영해요. 안내데스크에 가서 모임에 대해 묻고 등록해 보세요.",
      "你所在的分馆有免费的英语会话小组。走到服务台，询问并报名。"
    ),
    prompts: [
      {
        id: "p1",
        ask: t("Open the conversation and ask if the group exists.", "대화를 시작하고 모임이 있는지 물어보세요.", "开口打招呼，并询问是否有这个小组。"),
        target: "Hi! Do you have an English conversation group here?",
      },
      {
        id: "p2",
        ask: t("Ask when it meets and how to join.", "언제 모이는지, 어떻게 참여하는지 물어보세요.", "询问什么时候聚会、如何加入。"),
        target: "When does the group meet, and how do I sign up?",
      },
      {
        id: "p3",
        ask: t("The librarian spoke too fast. Ask them to repeat.", "사서가 너무 빨리 말했어요. 다시 말해달라고 부탁하세요.", "图书管理员说得太快了。请对方再说一遍。"),
        target: "Could you say that again, a little more slowly, please?",
      },
    ],
    criteria: [
      {
        id: "q1",
        type: "choice",
        label: t("Natural opener", "자연스러운 첫 마디", "自然的开场"),
        prompt: "You walk up to the front desk. What is the most natural way to start?",
        choices: [
          "Give me the English group schedule.",
          "Hi! Do you have an English conversation group here?",
          "I will now speak English with your group.",
        ],
        answer: 1,
      },
      {
        id: "q2",
        type: "choice",
        label: t("Asking to join", "참여 요청", "请求加入"),
        prompt: "The group meets Thursdays at 6 pm and you want to join. What do you ask?",
        choices: ["Thursday is not good weather.", "You must add my name.", "Great — how do I sign up?"],
        answer: 2,
      },
      {
        id: "q3",
        type: "choice",
        label: t("Asking to repeat", "다시 말해달라고 하기", "请求重复"),
        prompt: "You missed the room number. What do you say?",
        choices: [
          "Could you say that again, a little more slowly, please?",
          "(Say nothing and walk away.)",
          "Your English is too fast. Fix it.",
        ],
        answer: 0,
      },
      {
        id: "phrase",
        type: "phrase",
        label: t('Says "conversation group"', '"conversation group"라고 말하기', '说出 "conversation group"'),
        anyOf: ["conversation group", "conversation club", "conversation circle"],
      },
      {
        id: "question",
        type: "question",
        label: t("Asks it as a question", "질문 형태로 말하기", "用疑问句提问"),
      },
    ],
  }),
  mission({
    slug: "pharmacy-prescription",
    icon: "💊",
    minutes: 3,
    title: t("Pick up a prescription at the pharmacy", "약국에서 처방약 받기", "在药房取处方药"),
    place: t("Shoppers Drug Mart, pharmacy counter", "약국 조제 카운터", "药房柜台"),
    scenario: t(
      "Your doctor sent a prescription to the pharmacy. You go to the counter to pick it up and ask how to take it.",
      "의사가 처방전을 약국으로 보냈어요. 카운터에 가서 약을 받고 복용법을 물어보세요.",
      "医生把处方发到了药房。到柜台取药，并询问用法。"
    ),
    prompts: [
      {
        id: "p1",
        ask: t("Say you are picking up a prescription.", "처방약을 찾으러 왔다고 말하세요.", "说明你来取处方药。"),
        target: "Hi, I'm here to pick up a prescription.",
      },
      {
        id: "p2",
        ask: t("Ask how often to take it.", "얼마나 자주 복용하는지 물어보세요.", "询问多久服用一次。"),
        target: "How often should I take this?",
      },
      {
        id: "p3",
        ask: t("Ask whether it is safe with food.", "음식과 함께 먹어도 되는지 물어보세요.", "询问是否可以随餐服用。"),
        target: "Is it okay to take it with food?",
      },
    ],
    criteria: [
      {
        id: "q1",
        type: "choice",
        label: t("Stating your purpose", "용건 말하기", "说明来意"),
        prompt: "You reach the pharmacy counter. What do you say first?",
        choices: ["Medicine. Now.", "Hi, I'm here to pick up a prescription.", "My doctor is very good."],
        answer: 1,
      },
      {
        id: "q2",
        type: "choice",
        label: t("Asking about dosage", "복용법 묻기", "询问剂量"),
        prompt: "The pharmacist hands you the bag. You want to know the dosage. What do you ask?",
        choices: ["How often should I take this?", "How much money is your salary?", "Is this the correct?"],
        answer: 0,
      },
      {
        id: "q3",
        type: "choice",
        label: t("Understanding a warning", "주의사항 이해하기", "理解注意事项"),
        prompt: '"Take it with food, and avoid alcohol." What does this mean?',
        choices: [
          "Eat something when you take it; do not drink alcohol.",
          "Only take it at a restaurant.",
          "Take it with a glass of wine.",
        ],
        answer: 0,
      },
      {
        id: "phrase",
        type: "phrase",
        label: t('Says "prescription"', '"prescription"이라고 말하기', '说出 "prescription"'),
        anyOf: ["prescription"],
      },
      {
        id: "question",
        type: "question",
        label: t("Asks at least one question", "질문을 하나 이상 하기", "至少提一个问题"),
      },
    ],
  }),
  mission({
    slug: "school-office-absence",
    icon: "🏫",
    minutes: 3,
    title: t("Report your child's absence at the school office", "학교 사무실에 자녀 결석 알리기", "到学校办公室为孩子请假"),
    place: t("Elementary school, main office", "초등학교 교무실", "小学 校务办公室"),
    scenario: t(
      "Your child is sick and will miss school today. You call or visit the office to let them know and ask about homework.",
      "아이가 아파서 오늘 학교에 못 가요. 사무실에 알리고 숙제는 어떻게 하는지 물어보세요.",
      "孩子生病了，今天不能上学。联系办公室说明情况，并询问作业安排。"
    ),
    prompts: [
      {
        id: "p1",
        ask: t("Explain that your child will be absent today.", "아이가 오늘 결석한다고 설명하세요.", "说明孩子今天缺席。"),
        target: "Hi, I'm calling to let you know my son will be absent today. He's not feeling well.",
      },
      {
        id: "p2",
        ask: t("Ask what they need from you.", "필요한 게 있는지 물어보세요.", "询问需要你提供什么。"),
        target: "Do you need a note from me, or is this call enough?",
      },
      {
        id: "p3",
        ask: t("Ask about missed homework.", "빠진 숙제에 대해 물어보세요.", "询问落下的作业。"),
        target: "Could you let the teacher know, and is there any homework he should catch up on?",
      },
    ],
    criteria: [
      {
        id: "q1",
        type: "choice",
        label: t("Reporting the absence", "결석 알리기", "报告缺席"),
        prompt: "The office answers the phone. What do you say?",
        choices: [
          "Hi, I'm calling to let you know my daughter will be absent today.",
          "My daughter no school.",
          "Where is the teacher right now?",
        ],
        answer: 0,
      },
      {
        id: "q2",
        type: "choice",
        label: t("Understanding the reply", "답변 이해하기", "理解回复"),
        prompt: '"No problem — I\'ll mark her as excused. Feel better soon!" What happened?',
        choices: [
          "The absence is recorded and accepted.",
          "You need to bring her to school anyway.",
          "You are in trouble with the principal.",
        ],
        answer: 0,
      },
      {
        id: "q3",
        type: "choice",
        label: t("Asking about homework", "숙제 묻기", "询问作业"),
        prompt: "You want to know about homework. What do you ask?",
        choices: [
          "Is there any homework she should catch up on?",
          "Give the homework to me now.",
          "Homework is not important for us.",
        ],
        answer: 0,
      },
      {
        id: "phrase",
        type: "phrase",
        label: t('Says "absent" or "sick"', '"absent" 또는 "sick" 말하기', '说出 "absent" 或 "sick"'),
        anyOf: ["absent", "sick", "not feeling well", "unwell"],
      },
      {
        id: "question",
        type: "question",
        label: t("Asks at least one question", "질문을 하나 이상 하기", "至少提一个问题"),
      },
    ],
  }),
];

const missionsById = new Map(MISSIONS.map((m) => [m.missionId, m]));

function getMission(missionId) {
  return missionsById.get(missionId) ?? null;
}

/** What the browser is allowed to see: everything except the answer keys. */
function missionForClient(m) {
  return {
    missionId: m.missionId,
    slug: m.slug,
    icon: m.icon,
    minutes: m.minutes,
    version: m.version,
    reward: m.reward,
    title: m.title,
    place: m.place,
    scenario: m.scenario,
    prompts: m.prompts.map(({ id, ask }) => ({ id, ask })),
    criteria: m.criteria.map((c) =>
      c.type === "choice"
        ? { id: c.id, type: c.type, label: c.label, prompt: c.prompt, choices: c.choices }
        : { id: c.id, type: c.type, label: c.label, hint: c.anyOf ? c.anyOf[0] : undefined }
    ),
  };
}

// ---------------------------------------------------------------- grading

const normalise = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Fixed criteria. Returns which were met and which were missed.
 *   all met            → passed  (award the configured amount)
 *   exactly one missed → review  (a person looks at it in the verifier console)
 *   otherwise          → failed  (try again)
 */
function grade(m, submission) {
  const answers = submission?.answers && typeof submission.answers === "object" ? submission.answers : {};
  const attempts = Array.isArray(submission?.attempts) ? submission.attempts.map(normalise) : [];
  const spoken = attempts.join(" \n ");

  const criteria = m.criteria.map((c) => {
    let met = false;
    if (c.type === "choice") met = Number(answers[c.id]) === c.answer;
    else if (c.type === "phrase") met = c.anyOf.some((p) => spoken.includes(p));
    else if (c.type === "question") met = attempts.some((a) => a.includes("?"));
    return { id: c.id, type: c.type, label: c.label, met };
  });

  const missed = criteria.filter((c) => !c.met).map((c) => c.id);
  const outcome = missed.length === 0 ? "passed" : missed.length === 1 ? "review" : "failed";
  return { outcome, passed: outcome === "passed", criteria, missed };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** Commitment to everything that was graded. The content stays off chain. */
function proofHash(handle, m, submission, nonce) {
  const graded = {
    answers: submission?.answers ?? {},
    attempts: Array.isArray(submission?.attempts) ? submission.attempts : [],
  };
  return hashParts("proof-v2", handle, m.missionId, m.version, canonicalJson(graded), nonce);
}

// ---------------------------------------------------------------- coach

const COACH_FIELDS = ["corrections", "explanation", "encouragement", "language"];

const LANGUAGE_NAMES = { en: "English", ko: "Korean", zh: "Simplified Chinese", es: "Spanish", fr: "French", tl: "Filipino", fa: "Persian", ar: "Arabic", pa: "Punjabi" };

/**
 * The allowlist. Whatever the coach — live model, offline stub, or an
 * attacker replaying as either — returned, only these four fields survive,
 * and each is coerced to its expected shape.
 */
function filterCoach(raw, fallbackLanguage = "en") {
  const src = raw && typeof raw === "object" ? raw : {};
  const corrections = Array.isArray(src.corrections)
    ? src.corrections.slice(0, 5).map((c) => ({
        original: String(c?.original ?? ""),
        better: String(c?.better ?? ""),
        why: String(c?.why ?? ""),
      }))
    : [];
  const out = {
    corrections,
    explanation: String(src.explanation ?? ""),
    encouragement: String(src.encouragement ?? ""),
    language: typeof src.language === "string" && src.language ? src.language.slice(0, 8) : fallbackLanguage,
  };
  // Belt and braces: the object literally has only these keys.
  for (const key of Object.keys(out)) if (!COACH_FIELDS.includes(key)) delete out[key];
  return out;
}

const OFFLINE_WHY = {
  en: (target) => `The most natural way to say this is “${target}”. Read it aloud twice.`,
  ko: (target) => `이 상황에서 가장 자연스러운 표현은 “${target}” 입니다. 소리 내어 두 번 읽어보세요.`,
  zh: (target) => `最自然的说法是 “${target}”。请大声读两遍。`,
};
const OFFLINE_CLOSE = {
  en: "That phrasing is natural — deliver it with a gentle rising tone.",
  ko: "표현이 자연스러워요. 끝을 부드럽게 올려서 말해보세요.",
  zh: "这个说法很自然——句尾语调稍微上扬即可。",
};
const OFFLINE_EXPLANATION = {
  en: "Short, polite questions work best at a counter: a greeting, then one clear question.",
  ko: "카운터에서는 짧고 공손한 질문이 가장 잘 통해요: 인사 한 마디, 그리고 명확한 질문 하나.",
  zh: "在柜台前，简短礼貌的问题最有效：先打招呼，再问一个清楚的问题。",
};
const OFFLINE_ENCOURAGEMENT = {
  en: "Nice work — this will absolutely work in real life!",
  ko: "좋아요, 실제 상황에서도 분명히 통할 거예요!",
  zh: "很好——在现实生活中一定行得通！",
};

const pick = (table, lang) => table[lang] ?? table.en;

/**
 * The offline coach. Deliberately returns `pass` and `credits` so the test
 * suite can prove the filter strips them. Prompt-inject it all you like.
 */
function offlineCoach({ mission: m, attempts, language }) {
  const lang = language in OFFLINE_WHY ? language : "en";
  const corrections = m.prompts.map((p, i) => {
    const original = String(attempts?.[i] ?? "");
    const close = normalise(original).replace(/[^a-z? ]/g, "") === normalise(p.target).replace(/[^a-z? ]/g, "");
    return { original, better: p.target, why: close ? pick(OFFLINE_CLOSE, lang) : pick(OFFLINE_WHY, lang)(p.target) };
  });
  return {
    corrections,
    explanation: pick(OFFLINE_EXPLANATION, lang),
    encouragement: pick(OFFLINE_ENCOURAGEMENT, lang),
    language: lang,
    // These two fields exist to be stripped. If they ever reach a client or
    // the ledger, the allowlist is broken and a test fails.
    pass: true,
    credits: 999999,
    source: "offline",
  };
}

function loadAnthropicSdk() {
  const candidates = ["@anthropic-ai/sdk", path.join(__dirname, "..", "node_modules", "@anthropic-ai", "sdk"), path.join(__dirname, "..", "web", "node_modules", "@anthropic-ai", "sdk")];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      return mod.default ?? mod;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

let sdkCache;
function liveCoachAvailable() {
  if (process.env.COACH !== "live") return false;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return false;
  if (sdkCache === undefined) sdkCache = loadAnthropicSdk();
  return Boolean(sdkCache);
}

const COACH_SCHEMA = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: { original: { type: "string" }, better: { type: "string" }, why: { type: "string" } },
        required: ["original", "better", "why"],
        additionalProperties: false,
      },
    },
    explanation: { type: "string" },
    encouragement: { type: "string" },
  },
  required: ["corrections", "explanation", "encouragement"],
  additionalProperties: false,
};

/** Live coach via Claude. Never grades; its schema has no room to. */
async function liveCoach({ mission: m, attempts, language }) {
  const Anthropic = sdkCache;
  const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  const languageName = LANGUAGE_NAMES[language] ?? "English";
  const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 2048,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: COACH_SCHEMA } },
    system:
      "You are a warm, practical English coach for newcomers to Vancouver, Canada. " +
      "You comment on phrasing only: rewrite each attempt as a natural, polite sentence a local would say, and explain why in one or two sentences. " +
      "You never grade, never award anything, and never mention scores, passing, credits or rewards. " +
      `Write 'why', 'explanation' and 'encouragement' in ${languageName}; keep 'better' in English. ` +
      "Return one correction per attempt, in order.",
    messages: [
      {
        role: "user",
        content:
          `Scenario: ${m.scenario.en}\n` +
          m.prompts.map((p, i) => `Attempt ${i + 1} (task: ${p.ask.en})\nLearner wrote: "${String(attempts?.[i] ?? "")}"\nA typical phrasing: "${p.target}"`).join("\n\n"),
      },
    ],
  });
  if (response.stop_reason === "refusal") return null;
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  return { ...parsed, language };
}

/**
 * The coach entry point. Whatever produced the answer, it leaves through
 * filterCoach. Any failure of the live coach falls back to the offline one —
 * the demo never stops because an external API did.
 */
async function coach({ mission: m, attempts, language = "en", allowLive = false }) {
  let raw = null;
  let source = "offline";
  if (allowLive && liveCoachAvailable()) {
    try {
      raw = await liveCoach({ mission: m, attempts, language });
      if (raw) source = "live";
    } catch {
      raw = null;
    }
  }
  if (!raw) raw = offlineCoach({ mission: m, attempts, language });
  const filtered = filterCoach(raw, language);
  return { feedback: filtered, source };
}

module.exports = {
  MISSIONS,
  COACH_FIELDS,
  COACH_SCHEMA,
  getMission,
  missionForClient,
  grade,
  proofHash,
  canonicalJson,
  filterCoach,
  offlineCoach,
  coach,
  liveCoachAvailable,
};
