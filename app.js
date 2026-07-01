/* =========================================================
   鑑定タスク管理アプリ
   - データはブラウザの localStorage に永続化（バックエンド不要）
   - 認証なし・個人利用・PCブラウザ向け
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_KEY = "kantei-task-app:v1";

  /** 鑑定タイプの定義（表示名・バッジ色クラス） */
  const KANTEI = {
    free:   { label: "無料鑑定", badge: "badge-free" },
    honkan: { label: "本鑑定",   badge: "badge-honkan" },
    upsell: { label: "アップセル", badge: "badge-upsell" },
  };
  const KANTEI_KEYS = ["free", "honkan", "upsell"];

  /** 顧客のフェーズ（営業段階）。全員「無料鑑定」から始まる */
  const PHASES = ["無料鑑定", "本鑑定", "アップセル", "リピート"];

  const formatYen = (n) => "¥" + (Number(n) || 0).toLocaleString("ja-JP");

  /** 本鑑定の鑑定プラン（松竹梅）と料金。LTVに自動加算される */
  const PLANS = ["松", "竹", "梅"];
  const PLAN_PRICE = { "松": 14800, "竹": 7980, "梅": 0 };
  const planLabel = (p) => PLAN_PRICE[p] ? `${p}（${formatYen(PLAN_PRICE[p])}）` : p;

  // ---------------------------------------------------------
  // 状態管理 / 永続化
  // ---------------------------------------------------------
  /** @type {{customers: any[], tasks: any[], settings: {theme: string}}} */
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("データ読み込みに失敗しました", e);
    }
    return {
      customers: [], tasks: [],
      settings: { theme: "light", lastDailyReset: "" },
      character: { name: "ぼうけんしゃ", icon: "🧙" },
    };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------------------------------------------------------
  // DOM 参照
  // ---------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const dailyList = $("#daily-list");
  const dailyEmpty = $("#daily-empty");
  const todayList = $("#today-list");
  const todayEmpty = $("#today-empty");
  const customerList = $("#customer-list");
  const customerEmpty = $("#customer-empty");
  const overlay = $("#modal-overlay");
  const modalTitle = $("#modal-title");
  const modalBody = $("#modal-body");

  // ---------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined && v !== false) {
        node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function customerById(id) {
    return state.customers.find((c) => c.id === id) || null;
  }

  function formatDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-");
    return `${Number(m)}/${Number(day)}`;
  }

  function isOverdue(dueDate, completed) {
    if (!dueDate || completed) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(dueDate) < today;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => toISO(new Date());

  /** 今日のタスクの並び順キー（手動優先順位。未設定は作成日時） */
  const orderKey = (t) => (t.order != null ? t.order : t.createdAt);

  /** クリップボードへコピー（file:// でも動くようフォールバック付き） */
  function copyToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** 毎日のタスクは日付が変わったら（24時に）チェックを全て外す */
  function resetDailyIfNeeded() {
    const today = todayISO();
    if (state.settings.lastDailyReset === today) return;
    state.tasks.forEach((t) => { if (t.schedule === "daily") t.completed = false; });
    state.settings.lastDailyReset = today;
    save();
  }

  /** 次の0:00にリセット＆再描画をスケジュール（起動中に日付が変わった場合の対応） */
  function scheduleMidnightReset() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    setTimeout(() => {
      resetDailyIfNeeded();
      renderTasks();
      renderCalendar();
      scheduleMidnightReset();
    }, next - now);
  }

  // ---------------------------------------------------------
  // テーマ（ダークモード）
  // ---------------------------------------------------------
  function applyTheme() {
    const dark = state.settings.theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("#theme-toggle").textContent = dark ? "☀️" : "🌙";
  }

  $("#theme-toggle").addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    save();
    applyTheme();
  });

  // ---------------------------------------------------------
  // タブ切り替え
  // ---------------------------------------------------------
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
      tab.classList.add("is-active");
      $("#view-" + tab.dataset.view).classList.add("is-active");
    });
  });

  // ---------------------------------------------------------
  // モーダル制御
  // ---------------------------------------------------------
  function openModal(title, bodyNode) {
    modalTitle.textContent = title;
    modalBody.replaceChildren(bodyNode);
    overlay.hidden = false;
  }
  function closeModal() {
    overlay.hidden = true;
    modalBody.replaceChildren();
  }
  $("#modal-close").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeModal();
  });

  // =========================================================
  // タスク：レンダリング
  // =========================================================
  /** 1件のタスク行を生成（毎日／今日の両カラム・日付ポップアップで共用）
   *  opts.reorderable=true で優先順位（順位バッジ＋↑↓ボタン）を表示 */
  function buildTaskItem(task, opts = {}) {
    const customer = task.customerId ? customerById(task.customerId) : null;
    const typeMeta = task.type !== "custom" ? KANTEI[task.type] : null;

    const title = task.type === "custom"
      ? task.title
      : `${customer ? customer.name + "さん｜" : ""}${typeMeta.label}`;

    // スケジュール表示（完了時は「✅ 完了」で分かりやすく）
    const meta = el("div", { class: "task-meta" });
    if (typeMeta) meta.append(el("span", { class: "badge " + typeMeta.badge }, typeMeta.label));
    if (task.type === "honkan" && task.plan) {
      meta.append(el("span", { class: "badge badge-plan" }, "プラン:" + task.plan));
    }
    if (task.schedule === "daily") {
      meta.append(el("span", { class: "due" }, "🔁 毎日"));
    } else if (task.completed) {
      meta.append(el("span", { class: "due is-done-due" }, "✅ 完了"));
    } else if (task.dueDate) {
      meta.append(el("span", {
        class: "due" + (isOverdue(task.dueDate, task.completed) ? " is-overdue" : ""),
      }, "📅 " + formatDate(task.dueDate)));
    }

    const actions = el("div", { class: "row-actions" });
    if (opts.reorderable) {
      actions.append(
        el("button", { class: "btn btn-sm btn-top", disabled: opts.isFirst, title: "最優先にする", onclick: () => moveTodayTop(task.id) }, "⭐最優先"),
        el("button", { class: "btn btn-sm btn-move", disabled: opts.isFirst, title: "順位を上げる", onclick: () => moveToday(task.id, -1) }, "↑"),
        el("button", { class: "btn btn-sm btn-move", disabled: opts.isLast, title: "順位を下げる", onclick: () => moveToday(task.id, 1) }, "↓"),
      );
    }
    actions.append(
      el("button", { class: "btn btn-sm", onclick: () => openTaskForm(task.id) }, "編集"),
      el("button", { class: "btn btn-sm btn-danger", onclick: () => deleteTask(task.id) }, "削除"),
    );

    return el("li", { class: "task-item" + (task.completed ? " is-done" : "") },
      el("input", {
        type: "checkbox", class: "task-check", checked: task.completed,
        onchange: () => toggleTask(task.id),
      }),
      el("div", { class: "task-main", onclick: () => openTaskDetail(task.id) },
        el("div", { class: "task-title" },
          opts.reorderable ? el("span", { class: "rank-badge" }, String(opts.rank)) : null,
          title,
        ),
        meta.children.length ? meta : null,
      ),
      actions,
    );
  }

  function renderTaskColumn(listEl, emptyEl, tasks, reorderable) {
    listEl.replaceChildren();
    emptyEl.style.display = tasks.length ? "none" : "block";
    tasks.forEach((t, i) => listEl.append(buildTaskItem(t, reorderable
      ? { reorderable: true, rank: i + 1, isFirst: i === 0, isLast: i === tasks.length - 1 }
      : {})));
  }

  /** 今日のタスクの優先順位を上下に移動 */
  function moveToday(id, dir) {
    const today = todayISO();
    const list = state.tasks
      .filter((t) => t.schedule !== "daily" && t.dueDate === today)
      .sort((a, b) => orderKey(a) - orderKey(b));
    const i = list.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    // 隣り合うタスクの並び順キーを入れ替え
    const a = list[i], b = list[j];
    const ak = orderKey(a), bk = orderKey(b);
    a.order = bk; b.order = ak;
    save();
    renderTasks();
  }

  /** 指定タスクが今日のタスクの先頭（最優先）かどうか */
  function isTodayTop(task) {
    if (!task || task.schedule === "daily") return false;
    const today = todayISO();
    const list = state.tasks
      .filter((t) => t.schedule !== "daily" && t.dueDate === today)
      .sort((a, b) => orderKey(a) - orderKey(b));
    return list.length > 0 && list[0].id === task.id;
  }

  /** 今日のタスクをワンクリックで最優先（先頭）に */
  function moveTodayTop(id) {
    const today = todayISO();
    const list = state.tasks.filter((t) => t.schedule !== "daily" && t.dueDate === today);
    const t = state.tasks.find((x) => x.id === id);
    if (!t || !list.length) return;
    const minKey = Math.min(...list.map(orderKey));
    t.order = minKey - 1; // 現在の最小より小さくして先頭へ
    save();
    renderTasks();
  }

  function renderTasks() {
    const today = todayISO();
    // 毎日：未完了を上→作成順
    const dailySort = (a, b) =>
      a.completed !== b.completed ? (a.completed ? 1 : -1) : a.createdAt - b.createdAt;
    // 今日：手動の優先順位（order）順
    const todaySort = (a, b) => orderKey(a) - orderKey(b);

    const dailyTasks = state.tasks.filter((t) => t.schedule === "daily").sort(dailySort);
    const todayTasks = state.tasks
      .filter((t) => t.schedule !== "daily" && t.dueDate === today).sort(todaySort);

    renderTaskColumn(dailyList, dailyEmpty, dailyTasks, false);
    renderTaskColumn(todayList, todayEmpty, todayTasks, true);
    renderCharacter();
  }

  function toggleTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (t) { t.completed = !t.completed; save(); renderTasks(); renderCalendar(); }
  }

  function deleteTask(id) {
    if (!confirm("このタスクを削除しますか？")) return;
    const task = state.tasks.find((x) => x.id === id);
    // このタスクがLTVへ加算した分を取り消す
    if (task && task.ltvApplied && task.customerId) {
      const c = customerById(task.customerId);
      if (c) c.ltv = Math.max(0, (c.ltv || 0) - task.ltvApplied);
    }
    state.tasks = state.tasks.filter((x) => x.id !== id);
    save();
    renderTasks();
    renderCustomers();
    renderCalendar();
  }

  // =========================================================
  // タスク：作成・編集フォーム
  // =========================================================
  function openTaskForm(id) {
    const editing = id ? state.tasks.find((x) => x.id === id) : null;
    const linkedCustomer = editing && editing.customerId ? customerById(editing.customerId) : null;
    const data = editing || {
      type: "custom", title: "", customerId: "",
      schedule: "daily", dueDate: "",
    };

    const form = el("form", { class: "task-form" });

    let currentType = data.type;
    let schedule = data.schedule || (data.dueDate ? "deadline" : "daily");
    let plan = data.plan || (linkedCustomer && linkedCustomer.honkanPlan) || PLANS[0];

    // --- 種別セグメント（タスク名 or 鑑定タイプ） ---
    const typeSeg = el("div", { class: "seg" });
    const typeOptions = [
      { value: "custom", label: "タスク名入力" },
      { value: "free", label: "無料鑑定" },
      { value: "honkan", label: "本鑑定" },
      { value: "upsell", label: "アップセル" },
    ];

    // タスク名フィールド（タスク名入力のとき）
    const titleField = el("div", { class: "field" },
      el("label", {}, "タスク名"),
      el("input", { type: "text", name: "title", value: data.title || "", placeholder: "例：予約確認の連絡" }),
    );

    // 顧客名フィールド（鑑定のとき・直接入力＋既存候補）
    const customerListId = "customer-name-options";
    const datalist = el("datalist", { id: customerListId },
      ...state.customers.map((c) => el("option", { value: c.name })));
    const customerNameField = el("div", { class: "field" },
      el("label", {}, "顧客名"),
      el("input", {
        type: "text", name: "customerName", list: customerListId,
        value: linkedCustomer ? linkedCustomer.name : "", placeholder: "例：山田 花子",
      }),
      datalist,
    );

    // 鑑定プランフィールド（本鑑定のとき・松竹梅）
    const planSeg = el("div", { class: "seg" });
    const planField = el("div", { class: "field" },
      el("label", {}, "鑑定プラン"), planSeg);

    // 鑑定内容フィールド（鑑定のとき）
    const contentArea = el("textarea", { name: "content", placeholder: "鑑定内容・結果をここに記録…" });
    if (linkedCustomer && currentType !== "custom") {
      contentArea.value = (linkedCustomer.results && linkedCustomer.results[currentType]) || "";
    }
    const contentField = el("div", { class: "field" },
      el("label", {}, "鑑定内容"),
      contentArea,
    );

    // --- スケジュールセグメント（タスク名入力のときのみ：毎日 or 期限あり） ---
    const scheduleSeg = el("div", { class: "seg" });
    const scheduleOptions = [
      { value: "daily", label: "毎日" },
      { value: "deadline", label: "期限あり" },
    ];
    const scheduleField = el("div", { class: "field" },
      el("label", {}, "スケジュール"), scheduleSeg);
    const dueField = el("div", { class: "field" },
      el("label", {}, "期限"),
      el("input", { type: "date", name: "dueDate", value: data.dueDate || todayISO() }),
    );

    function refreshUI() {
      typeSeg.querySelectorAll(".seg-option").forEach((o) =>
        o.classList.toggle("is-selected", o.dataset.value === currentType));
      const isCustom = currentType === "custom";
      const isFree = currentType === "free";
      // 鑑定タスク（本鑑定/アップセル）は「期限」のみ。無料鑑定は期限なし
      if (!isCustom) schedule = "deadline";
      scheduleSeg.querySelectorAll(".seg-option").forEach((o) =>
        o.classList.toggle("is-selected", o.dataset.value === schedule));
      planSeg.querySelectorAll(".seg-option").forEach((o) =>
        o.classList.toggle("is-selected", o.dataset.value === plan));
      titleField.style.display = isCustom ? "block" : "none";
      customerNameField.style.display = isCustom ? "none" : "block";
      contentField.style.display = isCustom ? "none" : "block";
      planField.style.display = currentType === "honkan" ? "block" : "none";
      scheduleField.style.display = isCustom ? "block" : "none";
      // 無料鑑定は期限欄を出さない
      const showDue = isCustom ? schedule === "deadline" : !isFree;
      dueField.style.display = showDue ? "block" : "none";
    }

    typeOptions.forEach((opt) => {
      const o = el("label", { class: "seg-option", dataset: { value: opt.value } }, opt.label);
      o.addEventListener("click", () => {
        currentType = opt.value;
        // 種別を切り替えたら、その種別の保存済み鑑定内容に同期
        if (linkedCustomer && currentType !== "custom") {
          contentArea.value = (linkedCustomer.results && linkedCustomer.results[currentType]) || "";
        }
        refreshUI();
      });
      typeSeg.append(o);
    });
    scheduleOptions.forEach((opt) => {
      const o = el("label", { class: "seg-option", dataset: { value: opt.value } }, opt.label);
      o.addEventListener("click", () => { schedule = opt.value; refreshUI(); });
      scheduleSeg.append(o);
    });
    PLANS.forEach((value) => {
      const o = el("label", { class: "seg-option", dataset: { value } }, planLabel(value));
      o.addEventListener("click", () => { plan = value; refreshUI(); });
      planSeg.append(o);
    });

    // 最優先チェック（今日のタスクで先頭に）。編集時に既に先頭ならON
    const topCheck = el("input", { type: "checkbox", checked: editing ? isTodayTop(editing) : false });
    const topField = el("div", { class: "field" },
      el("label", { class: "check-row" }, topCheck, "⭐ 今日のタスクで最優先にする"),
    );

    form.append(
      el("div", { class: "field" }, el("label", {}, "種別"), typeSeg),
      titleField,
      customerNameField,
      planField,
      contentField,
      scheduleField,
      dueField,
      topField,
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn", onclick: closeModal }, "キャンセル"),
        el("button", { type: "submit", class: "btn btn-primary" }, editing ? "更新" : "追加"),
      ),
    );

    refreshUI();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);

      if (currentType === "custom" && !String(fd.get("title")).trim()) {
        alert("タスク名を入力してください。");
        return;
      }
      if (currentType !== "custom" && !String(fd.get("customerName")).trim()) {
        alert("顧客名を入力してください。");
        return;
      }

      // 編集時：このタスクが過去にLTVへ加算した分を一旦取り消す（差分反映のため）
      if (editing && editing.ltvApplied && editing.customerId) {
        const oldCust = customerById(editing.customerId);
        if (oldCust) oldCust.ltv = Math.max(0, (oldCust.ltv || 0) - editing.ltvApplied);
      }

      // 鑑定タスクは顧客を find-or-create し、顧客管理へ自動登録
      let customerId = "";
      let ltvApplied = 0;
      if (currentType !== "custom") {
        const customer = findOrCreateCustomer(String(fd.get("customerName")));
        customer.kanteiTypes[currentType] = true;
        customer.results[currentType] = String(fd.get("content") || "");
        if (currentType === "honkan") customer.honkanPlan = plan;
        // 本鑑定のプラン料金を LTV に加算（松14,800 / 竹7,980 / 梅0）
        if (currentType === "honkan") {
          ltvApplied = PLAN_PRICE[plan] || 0;
          customer.ltv = (customer.ltv || 0) + ltvApplied;
        }
        customer.phase = computePhase(customer); // フェーズを自動更新
        customerId = customer.id;
      }

      // 期限：無料鑑定は欄がないので作成日（今日）を期限扱いにして「今日のタスク」に出す
      let dueDate = "";
      if (currentType === "free") {
        dueDate = data.dueDate || todayISO();
      } else if (schedule === "deadline") {
        dueDate = String(fd.get("dueDate") || "");
      }

      const payload = {
        type: currentType,
        title: currentType === "custom" ? String(fd.get("title")).trim() : "",
        customerId,
        plan: currentType === "honkan" ? plan : "",
        ltvApplied,
        schedule,
        dueDate,
      };

      let taskId;
      if (editing) {
        Object.assign(editing, payload);
        taskId = editing.id;
      } else {
        const newTask = { id: uid(), completed: false, createdAt: Date.now(), ...payload };
        state.tasks.push(newTask);
        taskId = newTask.id;
      }
      save();
      if (topCheck.checked) moveTodayTop(taskId); // 最優先チェック時は先頭へ
      renderTasks();
      renderCustomers();
      renderCalendar();
      closeModal();
    });

    openModal(editing ? "タスクを編集" : "新規タスク", form);
  }

  /** 顧客名で既存顧客を探し、なければ新規作成して返す */
  function findOrCreateCustomer(name) {
    const trimmed = name.trim();
    let c = state.customers.find((x) => x.name === trimmed);
    if (!c) {
      c = {
        id: uid(), createdAt: Date.now(), name: trimmed,
        phase: PHASES[0], ltv: 0,
        kanteiTypes: { free: false, honkan: false, upsell: false },
        results: { free: "", honkan: "", upsell: "" }, memo: "",
      };
      state.customers.push(c);
    }
    return c;
  }

  // =========================================================
  // タスク：詳細（鑑定結果ポップアップ）
  // =========================================================
  function openTaskDetail(id) {
    const task = state.tasks.find((x) => x.id === id);
    if (!task) return;

    // 鑑定タイプでない（タスク名入力）の場合はそのまま編集フォームへ
    if (task.type === "custom") { openTaskForm(id); return; }

    const customer = customerById(task.customerId);
    const typeMeta = KANTEI[task.type];

    const body = el("div", {});
    body.append(
      el("div", { class: "field" },
        el("label", {}, "顧客"),
        el("div", {}, customer ? customer.name + " さん" : "（顧客情報なし）"),
      ),
      el("div", { class: "field" },
        el("label", {}, "鑑定種別"),
        el("span", { class: "badge " + typeMeta.badge }, typeMeta.label),
      ),
    );

    if (customer && task.type !== "upsell") {
      body.append(el("hr", { class: "divider" }));
      body.append(el("div", { class: "section-label" }, "鑑定結果（この内容は顧客情報に保存されます）"));

      const resultArea = el("textarea", {
        name: "result",
        placeholder: typeMeta.label + "の結果をここに記録できます…",
      });
      resultArea.value = (customer.results && customer.results[task.type]) || "";

      body.append(
        el("div", { class: "result-block" },
          el("div", { class: "result-head" },
            el("span", { class: "badge " + typeMeta.badge }, typeMeta.label + "結果")),
          resultArea,
        ),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn", onclick: closeModal }, "閉じる"),
          el("button", {
            class: "btn btn-primary",
            onclick: () => {
              customer.results = customer.results || {};
              customer.results[task.type] = resultArea.value;
              save();
              closeModal();
            },
          }, "結果を保存"),
        ),
      );
    } else {
      body.append(el("div", { class: "modal-actions" },
        el("button", { class: "btn", onclick: closeModal }, "閉じる")));
    }

    openModal("タスク詳細", body);
  }

  // =========================================================
  // 顧客：レンダリング
  // =========================================================
  /** フェーズは鑑定タイプの進行度から自動算出（手動設定なし） */
  function computePhase(c) {
    const t = (c && c.kanteiTypes) || {};
    if (t.upsell) return "アップセル";
    if (t.honkan) return "本鑑定";
    return "無料鑑定"; // 無料のみ or 未着手 → 全員「無料鑑定」から
  }

  const PHASE_ORDER = { "無料鑑定": 0, "本鑑定": 1, "アップセル": 2, "リピート": 3 };
  let customerSort = { key: "", dir: 1 };        // key: "phase" | "ltv" / dir: 1=昇順, -1=降順
  let phaseFilter = new Set(PHASES);              // 表示するフェーズ（初期は全表示）

  function toggleCustomerSort(key) {
    if (customerSort.key === key) customerSort.dir *= -1;
    else { customerSort.key = key; customerSort.dir = 1; }
    renderCustomers();
  }

  function togglePhaseFilter(phase) {
    if (phaseFilter.has(phase)) phaseFilter.delete(phase);
    else phaseFilter.add(phase);
    renderCustomers();
  }

  function renderCustomers() {
    customerList.replaceChildren();
    customerEmpty.style.display = state.customers.length ? "none" : "block";
    if (!state.customers.length) return;

    // フェーズ表示フィルター
    const filterBar = el("div", { class: "phase-filter" },
      el("span", { class: "filter-label" }, "表示フェーズ："),
      ...PHASES.map((p) =>
        el("button", {
          type: "button",
          class: "chip" + (phaseFilter.has(p) ? " is-on" : ""),
          onclick: () => togglePhaseFilter(p),
        }, p)),
    );
    customerList.append(filterBar);

    const arrowFor = (key) =>
      customerSort.key === key ? (customerSort.dir === 1 ? " ▲" : " ▼") : "";
    const table = el("table", { class: "customer-table" },
      el("thead", {},
        el("tr", {},
          el("th", {}, "顧客名"),
          el("th", { class: "th-sortable", onclick: () => toggleCustomerSort("phase") }, "フェーズ" + arrowFor("phase")),
          el("th", { class: "th-sortable", onclick: () => toggleCustomerSort("ltv") }, "LTV" + arrowFor("ltv")),
          el("th", { class: "th-actions" }, ""),
        ),
      ),
    );

    // 並べ替え＋フィルター
    let rows = state.customers.filter((c) => phaseFilter.has(computePhase(c)));
    if (customerSort.key === "phase") {
      rows.sort((a, b) =>
        ((PHASE_ORDER[computePhase(a)] ?? 99) - (PHASE_ORDER[computePhase(b)] ?? 99)) * customerSort.dir);
    } else if (customerSort.key === "ltv") {
      rows.sort((a, b) => ((a.ltv || 0) - (b.ltv || 0)) * customerSort.dir);
    }

    const tbody = el("tbody", {});
    for (const c of rows) {
      const row = el("tr", { class: "customer-row" },
        // 顧客名（クリックで編集）
        el("td", { class: "td-name", onclick: () => openCustomerForm(c.id) },
          el("span", { class: "customer-name" }, c.name),
        ),
        el("td", {}, el("span", { class: "badge badge-phase" }, computePhase(c))),
        el("td", { class: "td-ltv" }, formatYen(c.ltv)),
        el("td", { class: "td-actions" },
          el("button", {
            class: "btn btn-sm",
            onclick: (e) => { e.stopPropagation(); openCustomerResults(c.id); },
          }, "鑑定結果"),
          el("button", {
            class: "btn btn-sm btn-danger",
            onclick: (e) => { e.stopPropagation(); deleteCustomer(c.id); },
          }, "削除"),
        ),
      );
      tbody.append(row);
    }

    table.append(tbody);
    customerList.append(table);
    renderCharacter();

    if (!rows.length) {
      customerList.append(el("p", { class: "hint", style: "margin-top:12px;text-align:center;" },
        "表示中のフェーズに該当する顧客がいません。"));
    }
  }

  function deleteCustomer(id) {
    const linked = state.tasks.filter((t) => t.customerId === id).length;
    const msg = linked
      ? `この顧客に紐づくタスクが ${linked} 件あります。顧客とそのタスクを削除しますか？`
      : "この顧客を削除しますか？";
    if (!confirm(msg)) return;
    state.customers = state.customers.filter((c) => c.id !== id);
    state.tasks = state.tasks.filter((t) => t.customerId !== id);
    save();
    renderCustomers();
    renderTasks();
  }

  // =========================================================
  // 顧客：作成・編集フォーム（鑑定タイプ選択 & 結果格納）
  // =========================================================
  function openCustomerForm(id) {
    const editing = id ? state.customers.find((x) => x.id === id) : null;
    const data = editing || {
      name: "", ltv: 0,
      kanteiTypes: { free: false, honkan: false, upsell: false },
      results: { free: "", honkan: "", upsell: "" }, memo: "",
    };

    const form = el("form", {});

    form.append(
      el("div", { class: "field" },
        el("label", {}, "顧客名"),
        el("input", { type: "text", name: "name", value: data.name || "", placeholder: "例：山田 花子", required: true }),
      ),
      el("div", { class: "field" },
        el("label", {}, "フェーズ（自動）"),
        el("div", {}, el("span", { class: "badge badge-phase" }, computePhase(data))),
      ),
      el("div", { class: "field" },
        el("label", {}, "LTV（累計売上・円）"),
        el("input", { type: "number", name: "ltv", min: "0", step: "1", value: data.ltv || 0 }),
      ),
      el("div", { class: "field" },
        el("label", {}, "メモ"),
        (() => { const t = el("textarea", { name: "memo", placeholder: "自由メモ…" }); t.value = data.memo || ""; return t; })(),
      ),
      // 鑑定結果は専用ポップアップで編集（既存顧客のみ）
      editing
        ? el("div", { class: "field" },
            el("button", { type: "button", class: "btn", onclick: () => openCustomerResults(editing.id) }, "🔮 鑑定結果を入力・確認"))
        : el("p", { class: "hint" }, "鑑定結果は登録後に「鑑定結果」ボタンから入力できます。"),
      el("div", { class: "modal-actions" },
        editing ? el("button", { type: "button", class: "btn btn-danger", onclick: () => deleteCustomer(editing.id) }, "削除") : null,
        el("button", { type: "button", class: "btn", onclick: closeModal }, "キャンセル"),
        el("button", { type: "submit", class: "btn btn-primary" }, editing ? "更新" : "追加"),
      ),
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get("name")).trim();
      if (!name) { alert("顧客名を入力してください。"); return; }

      const ltv = Math.max(0, Number(fd.get("ltv")) || 0);

      if (editing) {
        editing.name = name;
        editing.ltv = ltv;
        editing.memo = String(fd.get("memo") || "");
        editing.phase = computePhase(editing); // 鑑定タイプから自動更新
      } else {
        const kanteiTypes = { free: false, honkan: false, upsell: false };
        state.customers.push({
          id: uid(), createdAt: Date.now(), name, ltv, kanteiTypes,
          phase: computePhase({ kanteiTypes }),
          results: { free: "", honkan: "", upsell: "" }, memo: String(fd.get("memo") || ""),
        });
      }
      save();
      renderCustomers();
      renderTasks();
      closeModal();
    });

    openModal(editing ? "顧客を編集" : "新規顧客", form);
  }

  // =========================================================
  // 顧客：鑑定結果ポップアップ
  // =========================================================
  // 鑑定結果メニュー：種別ボタンを選ぶと、その種別の結果ポップアップを表示
  function openCustomerResults(id) {
    const customer = customerById(id);
    if (!customer) return;

    const body = el("div", {},
      el("p", { class: "hint" }, "確認・編集する鑑定を選んでください。"),
      el("div", { class: "result-menu" },
        el("button", { type: "button", class: "btn", onclick: () => openResultDetail(id, "free") }, "無料鑑定"),
        el("button", { type: "button", class: "btn", onclick: () => openResultDetail(id, "honkan") }, "本鑑定"),
        el("button", { type: "button", class: "btn", onclick: () => openResultDetail(id, "upsell") }, "アップセル"),
      ),
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn", onclick: closeModal }, "閉じる")),
    );

    openModal(customer.name + " さんの鑑定結果", body);
  }

  // 種別ごとの結果ポップアップ（アップセルは結果欄なし＝空）
  function openResultDetail(id, type) {
    const customer = customerById(id);
    if (!customer) return;
    customer.results = customer.results || { free: "", honkan: "", upsell: "" };

    const body = el("div", {});

    if (type === "upsell") {
      // アップセルは何もないポップアップ
      body.append(el("p", { class: "hint" }, "アップセルに記録する鑑定結果はありません。"));
      body.append(el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn", onclick: () => openCustomerResults(id) }, "戻る")));
    } else {
      const ta = el("textarea", { placeholder: KANTEI[type].label + "の結果…" });
      ta.value = customer.results[type] || "";
      const note = el("span", { class: "copy-note" });

      // 無料鑑定をクリックしたら内容を自動でコピー
      if (type === "free" && customer.results.free) {
        if (copyToClipboard(customer.results.free)) note.textContent = "✓ 内容をコピーしました";
      }

      body.append(
        el("div", { class: "result-block" },
          el("div", { class: "result-head" },
            el("span", { class: "badge " + KANTEI[type].badge }, KANTEI[type].label + "結果"),
            type === "honkan" && customer.honkanPlan
              ? el("span", { class: "badge badge-plan" }, "プラン:" + customer.honkanPlan)
              : null,
            note,
          ),
          ta,
        ),
        el("div", { class: "modal-actions" },
          el("button", { type: "button", class: "btn", onclick: () => openCustomerResults(id) }, "戻る"),
          el("button", {
            type: "button", class: "btn",
            onclick: () => { if (copyToClipboard(ta.value)) note.textContent = "✓ コピーしました"; },
          }, "📋 コピー"),
          el("button", {
            type: "button", class: "btn btn-primary",
            onclick: () => { customer.results[type] = ta.value; save(); closeModal(); },
          }, "保存"),
        ),
      );
    }

    openModal(customer.name + " さん｜" + KANTEI[type].label, body);
  }

  // =========================================================
  // カレンダー（期限の可視化）
  // =========================================================
  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  const calRef = new Date();
  calRef.setDate(1);

  function renderCalendar() {
    const cal = $("#calendar");
    if (!cal) return;
    cal.replaceChildren();

    const year = calRef.getFullYear();
    const month = calRef.getMonth();
    $("#cal-title").textContent = `${year}年 ${month + 1}月`;

    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = toISO(new Date());

    // 曜日ヘッダー
    WEEK.forEach((w, i) => {
      cal.append(el("div", {
        class: "cal-cell cal-head-cell" + (i === 0 ? " sun" : i === 6 ? " sat" : ""),
      }, w));
    });
    // 月初までの空セル
    for (let i = 0; i < firstWeekday; i++) cal.append(el("div", { class: "cal-cell cal-empty" }));

    // 日付セル
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
      const weekday = new Date(year, month, d).getDay();
      const dayTasks = state.tasks.filter((t) => t.schedule !== "daily" && t.dueDate === dateStr);
      const allDone = dayTasks.length > 0 && dayTasks.every((t) => t.completed);
      const hasOverdue = dayTasks.some((t) => !t.completed && dateStr < todayStr);

      const cell = el("div", {
        class: "cal-cell cal-day"
          + (dateStr === todayStr ? " is-today" : "")
          + (dayTasks.length ? " has-task" : ""),
      });
      cell.append(el("div", {
        class: "cal-num" + (weekday === 0 ? " sun" : weekday === 6 ? " sat" : ""),
      }, String(d)));

      if (dayTasks.length) {
        // 完了済み=緑✓ / 期限切れ=赤 / それ以外=件数
        const dotClass = "cal-dot" + (allDone ? " done" : hasOverdue ? " overdue" : "");
        const dotText = allDone ? "✓" : (dayTasks.length > 1 ? String(dayTasks.length) : "");
        cell.append(el("div", { class: dotClass }, dotText));
        cell.style.cursor = "pointer";
        cell.addEventListener("click", () => openDayTasks(dateStr));
      }
      cal.append(cell);
    }
  }

  function openDayTasks(dateStr) {
    const tasks = state.tasks.filter((t) => t.schedule !== "daily" && t.dueDate === dateStr);
    const body = el("div", {});
    const list = el("ul", { class: "task-list" });

    tasks.forEach((task) => {
      const customer = task.customerId ? customerById(task.customerId) : null;
      const typeMeta = task.type !== "custom" ? KANTEI[task.type] : null;
      const title = task.type === "custom"
        ? task.title
        : `${customer ? customer.name + "さん｜" : ""}${typeMeta.label}`;

      list.append(el("li", { class: "task-item" + (task.completed ? " is-done" : "") },
        el("input", {
          type: "checkbox", class: "task-check", checked: task.completed,
          onchange: () => { toggleTask(task.id); openDayTasks(dateStr); },
        }),
        el("div", { class: "task-main" }, el("div", { class: "task-title" }, title)),
      ));
    });

    if (!tasks.length) body.append(el("p", { class: "hint" }, "この日のタスクはありません。"));
    else body.append(list);
    body.append(el("div", { class: "modal-actions" },
      el("button", { class: "btn", onclick: closeModal }, "閉じる")));

    openModal(`${calRef.getFullYear()}/${formatDate(dateStr)} のタスク`, body);
  }

  // =========================================================
  // キャラクター＆ステータス（ドラクエ風）
  // =========================================================
  const CHAR_ICONS = ["🧙", "🧙‍♀️", "🦸", "🦸‍♀️", "🧝", "🧚", "🔮", "🐉", "🦄", "🐱", "⚔️", "👑"];
  const DEFAULT_CHAR = { name: "ぼうけんしゃ", icon: "🧙" };

  /** ステータスはアプリの活動量から自動算出（ゲーミフィケーション） */
  function computeStats() {
    const tasks = state.tasks;
    const completed = tasks.filter((t) => t.completed).length;
    const honkanDone = tasks.filter((t) => t.completed && t.type === "honkan").length;
    const freeDone = tasks.filter((t) => t.completed && t.type === "free").length;
    const upsellDone = tasks.filter((t) => t.completed && t.type === "upsell").length;
    const customers = state.customers.length;
    const gold = state.customers.reduce((s, c) => s + (c.ltv || 0), 0);
    const level = 1 + Math.floor(completed / 10);
    return {
      level,
      hp: 100 + level * 20 + honkanDone * 10,
      mp: 50 + level * 10 + freeDone * 5,
      power: completed * 3 + honkanDone * 10,
      charm: customers * 5 + upsellDone * 15,
      gold,
    };
  }

  function statRow(label, value) {
    return el("div", { class: "dq-row" },
      el("span", { class: "dq-label" }, label),
      el("span", { class: "dq-value" }, String(value)),
    );
  }

  function renderCharacter() {
    const panel = $("#char-panel");
    if (!panel) return;
    const ch = state.character || DEFAULT_CHAR;
    const s = computeStats();
    panel.replaceChildren(
      el("div", { class: "dq-window" },
        el("div", { class: "dq-head" },
          el("div", { class: "dq-icon" }, ch.icon),
          el("div", { class: "dq-name" }, ch.name),
          el("div", { class: "dq-lv" }, "Lv " + s.level),
        ),
        el("div", { class: "dq-stats" },
          statRow("HP", s.hp),
          statRow("MP", s.mp),
          statRow("パワー", s.power),
          statRow("チャーム", s.charm),
          statRow("ゴールド", formatYen(s.gold).replace("¥", "") + " G"),
        ),
        el("button", { type: "button", class: "dq-edit", onclick: openCharacterEdit }, "なまえ・アイコン"),
      ),
    );
  }

  function openCharacterEdit() {
    const ch = state.character || DEFAULT_CHAR;
    let icon = ch.icon;

    const iconGrid = el("div", { class: "icon-grid" });
    CHAR_ICONS.forEach((ic) => {
      const b = el("button", {
        type: "button",
        class: "icon-opt" + (ic === icon ? " is-selected" : ""),
        dataset: { ic },
        onclick: () => {
          icon = ic;
          iconGrid.querySelectorAll(".icon-opt").forEach((o) =>
            o.classList.toggle("is-selected", o.dataset.ic === icon));
        },
      }, ic);
      iconGrid.append(b);
    });

    const form = el("form", {},
      el("div", { class: "field" },
        el("label", {}, "なまえ"),
        el("input", { type: "text", name: "name", value: ch.name, maxlength: "12", placeholder: "ぼうけんしゃ" }),
      ),
      el("div", { class: "field" },
        el("label", {}, "アイコン"),
        iconGrid,
      ),
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn", onclick: closeModal }, "キャンセル"),
        el("button", { type: "submit", class: "btn btn-primary" }, "保存"),
      ),
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      state.character = { name: String(fd.get("name")).trim() || DEFAULT_CHAR.name, icon };
      save();
      renderCharacter();
      closeModal();
    });

    openModal("キャラクター設定", form);
  }

  // =========================================================
  // 顧客データの CSV インポート / エクスポート
  // =========================================================
  const CSV_HEADERS = [
    "顧客名", "フェーズ", "LTV",
    "無料鑑定", "本鑑定", "アップセル", "本鑑定プラン",
    "無料鑑定結果", "本鑑定結果", "アップセル結果", "メモ",
  ];

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n") {
        row.push(field); rows.push(row); row = []; field = "";
      } else if (ch !== "\r") {
        field += ch;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCustomersCSV() {
    if (!state.customers.length) { alert("出力する顧客がいません。"); return; }
    const rows = [CSV_HEADERS];
    state.customers.forEach((c) => {
      const k = c.kanteiTypes || {};
      const r = c.results || {};
      rows.push([
        c.name || "", computePhase(c), c.ltv || 0,
        k.free ? 1 : 0, k.honkan ? 1 : 0, k.upsell ? 1 : 0, c.honkanPlan || "",
        r.free || "", r.honkan || "", r.upsell || "", c.memo || "",
      ]);
    });
    const csv = "﻿" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadFile(csv, `customers_${todayISO()}.csv`, "text/csv;charset=utf-8;");
  }

  function importCustomersCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result));
        if (rows.length < 2) { alert("CSVにデータ行がありません。"); return; }

        const header = rows[0].map((h) => h.trim());
        const col = (name) => header.indexOf(name);
        const dataRows = rows.slice(1).filter((r) => r.some((cell) => String(cell).trim() !== ""));
        if (col("顧客名") < 0) { alert("「顧客名」列が見つかりません。"); return; }
        if (!confirm(`${dataRows.length} 件を取り込みます。\n同じ顧客名は上書きされます。よろしいですか？`)) return;

        const truthy = (v) => ["1", "○", "◯", "true", "TRUE", "yes", "はい"].includes(String(v).trim());
        let added = 0, updated = 0;

        dataRows.forEach((cols) => {
          const get = (name) => { const i = col(name); return i >= 0 ? (cols[i] ?? "") : ""; };
          const name = String(get("顧客名")).trim();
          if (!name) return;

          const kanteiTypes = {
            free: truthy(get("無料鑑定")),
            honkan: truthy(get("本鑑定")),
            upsell: truthy(get("アップセル")),
          };
          const results = {
            free: String(get("無料鑑定結果")),
            honkan: String(get("本鑑定結果")),
            upsell: String(get("アップセル結果")),
          };
          const ltv = Math.max(0, Number(String(get("LTV")).replace(/[^0-9.\-]/g, "")) || 0);
          const honkanPlan = String(get("本鑑定プラン")).trim();
          const memo = String(get("メモ"));

          let c = state.customers.find((x) => x.name === name);
          if (c) {
            c.ltv = ltv; c.kanteiTypes = kanteiTypes; c.results = results;
            if (honkanPlan) c.honkanPlan = honkanPlan;
            c.memo = memo; c.phase = computePhase(c);
            updated++;
          } else {
            c = {
              id: uid(), createdAt: Date.now(), name, ltv, kanteiTypes, results,
              honkanPlan, memo,
            };
            c.phase = computePhase(c);
            state.customers.push(c);
            added++;
          }
        });

        save();
        renderCustomers();
        renderTasks();
        alert(`インポート完了：新規 ${added} 件 / 更新 ${updated} 件`);
      } catch (e) {
        alert("CSVの読み込みに失敗しました：" + (e && e.message ? e.message : e));
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------
  // イベント結線 & 初期描画
  // ---------------------------------------------------------
  $("#new-task-btn").addEventListener("click", () => openTaskForm());
  $("#new-customer-btn").addEventListener("click", () => openCustomerForm());
  $("#csv-export-btn").addEventListener("click", exportCustomersCSV);
  $("#csv-import-btn").addEventListener("click", () => $("#csv-file-input").click());
  $("#csv-file-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importCustomersCSV(file);
    e.target.value = ""; // 同じファイルを再選択できるようリセット
  });
  $("#cal-prev").addEventListener("click", () => { calRef.setMonth(calRef.getMonth() - 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { calRef.setMonth(calRef.getMonth() + 1); renderCalendar(); });

  // 既存データの移行：フェーズを鑑定タイプから自動再計算
  let migrated = false;
  state.customers.forEach((c) => {
    const p = computePhase(c);
    if (c.phase !== p) { c.phase = p; migrated = true; }
  });
  if (migrated) save();

  if (!state.character) state.character = { ...DEFAULT_CHAR };

  resetDailyIfNeeded();   // 日付が変わっていれば毎日のタスクのチェックを外す
  scheduleMidnightReset(); // 起動中の0:00リセットを予約

  applyTheme();
  renderTasks();
  renderCustomers();
  renderCalendar();
  renderCharacter();
})();
