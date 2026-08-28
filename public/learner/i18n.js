// Interface strings for the learner app. Mission content itself stays in
// English (that is the practice); scenarios, criteria labels and the coach
// come back from the server in the learner's language.
(function () {
  const STRINGS = {
    en: {
      enrol_title: "Your participation code", enrol_body: "Pick up a code at the library, settlement agency or school running the programme. The code is what makes you one learner: clearing this browser and typing it again brings back the same balance and the same lifetime limit.", enrol_placeholder: "e.g. WELCOME-01", enrol_submit: "Start learning", enrol_invalid: "That code is not on the programme list. Check it with the desk that gave it to you.", enrol_demo: "Demo codes for this local run:", enrol_privacy: "The code is not a login. We store a one-way hash of it — no name, no e-mail, no phone number.",
      ledger_onchain: "On-chain", ledger_mirror: "Demo mirror", ledger_onchain_hint: "Every award, swap and refund on this run is a transaction on the LanguageCredits contract.", ledger_mirror_hint: "This run uses the JavaScript mirror of the contract, not a chain. Same rules, no transactions.",
      tagline: "Learn local. Earn local. Belong local.",
      nav_home: "Missions", nav_shop: "Shop", nav_wallet: "Wallet",
      balance_label: "Your credits", balance_worth: "≈ CAD {cad}", balance_expires: "Keep earning — credits expire {date}", balance_none: "Complete a mission to earn your first 100 credits.",
      paused: "The programme is paused right now. Nothing is lost.",
      missions_title: "Missions near you", mission_min: "{n} min", mission_reward: "+{n} credits", mission_done: "Done", mission_pending: "Being reviewed", mission_start: "Start · {n} minutes", mission_place: "Where", mission_reward_label: "Reward",
      practise_title: "Say it your way", practise_hint: "Type what you would actually say at the counter. Don't worry about mistakes — that's what the coach is for.", practise_coach: "Get coaching", practise_skip: "Skip to the check",
      coach_title: "Your coach says", coach_more_natural: "More natural", coach_next: "Now check yourself", coach_offline: "offline coach", coach_live: "live coach", coach_note: "The coach helps you. It never decides who gets paid — the check below does.", coach_consent: "Send these practice sentences to the external AI coach? Do not include names, addresses, phone numbers or other personal details.",
      check_title: "Quick check", check_phrase: "Your sentences above should include “{phrase}” and ask it as a question.", check_submit: "Submit for verification", check_answer_all: "Answer every question first.",
      result_passed: "Mission passed!", result_awarded: "+{n} credits are in your balance", result_review: "Almost — a person will take a look", result_review_body: "You missed one criterion. A verifier reviews it and can still award the full {n} credits. Check back in a bit.", result_failed: "Not yet", result_failed_body: "Review the criteria you missed and try again.", result_missed: "Missed", result_criteria: "Checked against fixed criteria", result_home: "Back to missions", result_shop: "Go to the shop", result_not_awarded: "Passed, but not paid:",
      shop_title: "Swap credits", shop_sub: "Real products, pre-funded by sponsors. 100 credits = CAD 5. No market, no price.", shop_stock: "{n} left", shop_out: "Sold out", shop_swap: "Swap for {n}", shop_confirm: "Swap {cost} credits for a {brand} CAD {value} card?", shop_yes: "Yes, swap", shop_no: "Not now", shop_processing: "Asking the provider…", shop_processing_sub: "Your credits are already burned; the swap stays open until a card is in hand.", shop_done: "Your card is in your wallet", shop_refunded: "The provider didn't complete the order. Your {n} credits are back.", shop_pending: "The provider has not confirmed the order yet. Your credits stay reserved while we check the same request — we will not order a second card.", shop_open_wallet: "Open wallet", shop_need: "Need {n} more",
      wallet_title: "Wallet", wallet_sub: "Cards are sealed to this device. The server holds only ciphertext.", wallet_empty: "No cards yet. Complete a mission and swap your credits.", wallet_reveal: "Reveal", wallet_hide: "Hide", wallet_number: "Card number", wallet_pin: "PIN", wallet_expiry: "Expires", wallet_order: "Order", wallet_recovered: "recovered after a provider timeout", wallet_revealed: "revealed {n}×", wallet_warning: "Clearing this site's data deletes the only key that can open your cards. Your credits come back with your participation code — the cards already issued do not.", wallet_refunded: "refunded", wallet_processing: "processing",
      footer: "No account. No e-mail. No wallet software. Your participation code — not this browser — keeps your balance.", handle: "Handle", lang: "Language", error: "Something went wrong. Please try again.", offline: "Can't reach the service.",
    },
    ko: {
      enrol_title: "참여 코드", enrol_body: "프로그램을 운영하는 도서관, 정착지원기관, 학교에서 코드를 받으세요. 이 코드가 “한 사람”을 정합니다. 브라우저를 지우고 다시 입력해도 같은 잔액과 같은 평생 한도로 돌아옵니다.", enrol_placeholder: "예: WELCOME-01", enrol_submit: "학습 시작", enrol_invalid: "프로그램 목록에 없는 코드예요. 코드를 준 창구에 확인해주세요.", enrol_demo: "이번 로컬 실행용 데모 코드:", enrol_privacy: "코드는 로그인이 아니에요. 단방향 해시만 저장하고 이름·이메일·전화번호는 받지 않아요.",
      ledger_onchain: "온체인", ledger_mirror: "데모 미러", ledger_onchain_hint: "이번 실행의 모든 지급·교환·환불은 LanguageCredits 컨트랙트의 실제 트랜잭션입니다.", ledger_mirror_hint: "이번 실행은 체인이 아니라 컨트랙트를 그대로 옮긴 자바스크립트 미러를 씁니다. 규칙은 같지만 트랜잭션은 없어요.",
      tagline: "동네에서 배우고, 동네에서 벌고, 동네에 속하기.",
      nav_home: "미션", nav_shop: "상점", nav_wallet: "지갑",
      balance_label: "내 크레딧", balance_worth: "≈ CAD {cad}", balance_expires: "계속 활동하세요 — 크레딧은 {date}에 만료돼요", balance_none: "미션 하나를 완료하면 첫 100 크레딧을 받아요.",
      paused: "프로그램이 잠시 중지되었어요. 잃는 것은 없어요.",
      missions_title: "내 주변 미션", mission_min: "{n}분", mission_reward: "+{n} 크레딧", mission_done: "완료", mission_pending: "검토 중", mission_start: "시작 · {n}분", mission_place: "장소", mission_reward_label: "보상",
      practise_title: "내 말로 해보기", practise_hint: "실제로 카운터에서 할 말을 그대로 써보세요. 틀려도 괜찮아요 — 코치가 도와줄 거예요.", practise_coach: "코칭 받기", practise_skip: "바로 확인으로",
      coach_title: "코치의 한마디", coach_more_natural: "더 자연스럽게", coach_next: "이제 직접 확인하기", coach_offline: "오프라인 코치", coach_live: "실시간 코치", coach_note: "코치는 도와줄 뿐이에요. 누가 보상을 받는지는 아래의 고정 검증이 결정해요.", coach_consent: "연습 문장을 외부 AI 코치에게 보낼까요? 이름, 주소, 전화번호 같은 개인정보는 입력하지 마세요.",
      check_title: "빠른 확인", check_phrase: "위에 쓴 문장에 “{phrase}”가 들어가고, 질문 형태여야 해요.", check_submit: "검증 제출", check_answer_all: "모든 문항에 먼저 답해주세요.",
      result_passed: "미션 통과!", result_awarded: "+{n} 크레딧이 적립되었어요", result_review: "거의 다 왔어요 — 검토자가 확인할게요", result_review_body: "기준 하나를 놓쳤어요. 검토자가 확인한 뒤 {n} 크레딧 전액을 줄 수 있어요. 잠시 후 다시 확인해보세요.", result_failed: "아직이에요", result_failed_body: "놓친 기준을 다시 보고 다시 도전해보세요.", result_missed: "놓친 기준", result_criteria: "고정된 기준으로 검증됨", result_home: "미션으로 돌아가기", result_shop: "상점으로 가기", result_not_awarded: "통과했지만 지급되지 않음:",
      shop_title: "크레딧 교환", shop_sub: "후원사가 미리 결제한 실제 상품. 100 크레딧 = CAD 5. 시장도, 시세도 없어요.", shop_stock: "{n}장 남음", shop_out: "품절", shop_swap: "{n}으로 교환", shop_confirm: "{cost} 크레딧을 {brand} CAD {value} 카드로 교환할까요?", shop_yes: "네, 교환할게요", shop_no: "나중에", shop_processing: "제공사에 요청 중…", shop_processing_sub: "크레딧은 이미 차감됐고, 카드가 손에 들어올 때까지 교환은 열려 있어요.", shop_done: "카드가 지갑에 들어왔어요", shop_refunded: "제공사가 주문을 완료하지 못했어요. {n} 크레딧이 돌아왔어요.", shop_pending: "제공사가 주문 결과를 아직 확정하지 않았어요. 같은 요청을 확인하는 동안 크레딧은 예약 상태로 남고, 두 번째 카드는 주문하지 않아요.", shop_open_wallet: "지갑 열기", shop_need: "{n} 더 필요",
      wallet_title: "지갑", wallet_sub: "카드는 이 기기에 봉인돼요. 서버는 암호문만 가지고 있어요.", wallet_empty: "아직 카드가 없어요. 미션을 완료하고 크레딧을 교환해보세요.", wallet_reveal: "보기", wallet_hide: "숨기기", wallet_number: "카드 번호", wallet_pin: "PIN", wallet_expiry: "만료", wallet_order: "주문", wallet_recovered: "제공사 시간 초과 후 복구됨", wallet_revealed: "{n}회 열람", wallet_warning: "사이트 데이터를 지우면 카드를 열 수 있는 유일한 키가 사라져요. 크레딧은 참여 코드로 돌아오지만, 이미 발급된 카드는 돌아오지 않아요.", wallet_refunded: "환불됨", wallet_processing: "처리 중",
      footer: "계정도, 이메일도, 지갑 앱도 없어요. 잔액을 지키는 건 이 브라우저가 아니라 참여 코드예요.", handle: "핸들", lang: "언어", error: "문제가 생겼어요. 다시 시도해주세요.", offline: "서비스에 연결할 수 없어요.",
    },
    zh: {
      enrol_title: "你的参与码", enrol_body: "请到举办本项目的图书馆、安置服务机构或学校领取参与码。参与码决定“一个人”：即使清除浏览器数据，重新输入后仍会回到相同的余额和相同的终身上限。", enrol_placeholder: "例如 WELCOME-01", enrol_submit: "开始学习", enrol_invalid: "该参与码不在项目名单中。请向发码的服务台确认。", enrol_demo: "本地演示用参与码：", enrol_privacy: "参与码不是账号。我们只保存它的单向哈希——不收集姓名、邮箱或电话。",
      ledger_onchain: "链上", ledger_mirror: "演示镜像", ledger_onchain_hint: "本次运行的每一次发放、兑换和退款都是 LanguageCredits 合约上的真实交易。", ledger_mirror_hint: "本次运行使用的是合约的 JavaScript 镜像，而非区块链。规则相同，但没有交易。",
      tagline: "在本地学习，在本地赚取，融入本地。",
      nav_home: "任务", nav_shop: "商店", nav_wallet: "钱包",
      balance_label: "我的积分", balance_worth: "≈ CAD {cad}", balance_expires: "继续练习 — 积分将于 {date} 过期", balance_none: "完成一个任务即可获得首批 100 积分。",
      paused: "项目暂时暂停。你不会损失任何东西。",
      missions_title: "附近的任务", mission_min: "{n} 分钟", mission_reward: "+{n} 积分", mission_done: "已完成", mission_pending: "审核中", mission_start: "开始 · {n} 分钟", mission_place: "地点", mission_reward_label: "奖励",
      practise_title: "用你的话说", practise_hint: "写下你在柜台前真正会说的话。不用担心出错——教练会帮你。", practise_coach: "获取指导", practise_skip: "直接去检查",
      coach_title: "教练说", coach_more_natural: "更自然的说法", coach_next: "现在自我检查", coach_offline: "离线教练", coach_live: "实时教练", coach_note: "教练只是帮助你。谁能获得奖励由下面的固定检查决定。", coach_consent: "要把这些练习句子发送给外部 AI 教练吗？请勿填写姓名、地址、电话号码或其他个人信息。",
      check_title: "快速检查", check_phrase: "上面的句子应包含 “{phrase}”，并以疑问句提出。", check_submit: "提交验证", check_answer_all: "请先回答所有问题。",
      result_passed: "任务通过！", result_awarded: "+{n} 积分已到账", result_review: "差一点 — 将由人工审核", result_review_body: "你漏掉了一项标准。审核员会查看，仍可授予全部 {n} 积分。稍后再来看看。", result_failed: "还差一点", result_failed_body: "回顾漏掉的标准，再试一次。", result_missed: "未达到", result_criteria: "按固定标准验证", result_home: "返回任务", result_shop: "去商店", result_not_awarded: "已通过，但未支付：",
      shop_title: "兑换积分", shop_sub: "真实商品，由赞助方预先付款。100 积分 = CAD 5。没有市场，没有价格。", shop_stock: "剩余 {n}", shop_out: "已售罄", shop_swap: "用 {n} 兑换", shop_confirm: "用 {cost} 积分兑换 {brand} CAD {value} 礼品卡？", shop_yes: "是的，兑换", shop_no: "暂不", shop_processing: "正在向供应商下单…", shop_processing_sub: "积分已扣除；在拿到卡之前，兑换保持开放。", shop_done: "礼品卡已放入你的钱包", shop_refunded: "供应商未能完成订单。你的 {n} 积分已退回。", shop_pending: "供应商尚未确认订单。我们会用同一个请求继续核对，积分保持预留状态，不会再次订购礼品卡。", shop_open_wallet: "打开钱包", shop_need: "还需 {n}",
      wallet_title: "钱包", wallet_sub: "礼品卡已加密绑定到此设备。服务器只保存密文。", wallet_empty: "还没有礼品卡。完成任务并兑换积分。", wallet_reveal: "显示", wallet_hide: "隐藏", wallet_number: "卡号", wallet_pin: "PIN", wallet_expiry: "有效期至", wallet_order: "订单", wallet_recovered: "供应商超时后已恢复", wallet_revealed: "已显示 {n} 次", wallet_warning: "清除本站数据会删除唯一能打开礼品卡的密钥。积分可以用参与码找回，但已发放的礼品卡不能。", wallet_refunded: "已退款", wallet_processing: "处理中",
      footer: "无需账户、电子邮件或钱包软件。保住余额的是参与码，而不是这个浏览器。", handle: "标识", lang: "语言", error: "出了点问题，请重试。", offline: "无法连接服务。",
    },
  };

  const LANGS = [
    { code: "en", label: "English" },
    { code: "ko", label: "한국어" },
    { code: "zh", label: "中文" },
  ];

  let current = "en";
  try {
    const saved = localStorage.getItem("languagetoken.lang");
    if (saved && STRINGS[saved]) current = saved;
    else {
      const nav = (navigator.language || "en").slice(0, 2);
      if (STRINGS[nav]) current = nav;
    }
  } catch {
    /* storage unavailable */
  }

  function t(key, vars = {}) {
    const s = STRINGS[current]?.[key] ?? STRINGS.en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  }

  // Right-to-left scripts are not translated yet; the hook is here so adding
  // one is a strings file, not a rewrite.
  const RTL = new Set(["ar", "fa", "ur", "he"]);

  /**
   * Tell the document which language it is in. Without this a screen reader
   * announces Korean and Chinese with an English voice — the app "supports"
   * three languages and is unusable in two of them for a blind learner.
   */
  function applyDocumentLanguage() {
    const el = document.documentElement;
    if (!el) return;
    el.lang = current;
    el.dir = RTL.has(current) ? "rtl" : "ltr";
  }

  function setLang(code) {
    if (!STRINGS[code]) return;
    current = code;
    try {
      localStorage.setItem("languagetoken.lang", code);
    } catch {
      /* ignore */
    }
    applyDocumentLanguage();
  }

  /** Pick a translated field from a server object like { en, ko, zh }. */
  const pick = (obj) => (obj && typeof obj === "object" ? obj[current] ?? obj.en ?? "" : String(obj ?? ""));

  applyDocumentLanguage(); // the saved or browser-detected language, before first paint

  window.LTi18n = { t, setLang, pick, LANGS, applyDocumentLanguage, get lang() { return current; } };
})();
