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

  /** 顧客のフェーズ（営業段階） */
  const PHASES = ["見込み", "無料鑑定", "本鑑定", "アップセル", "リピート"];
  const formatYen = (n) => "¥" + (Number(n) || 0).toLocaleString("ja-JP");

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
    return { customers: [], tasks: [], settings: { theme: "light" } };
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
  /** 1件のタスク行を生成（毎日／今日の両カラム・日付ポップアップで共用） */
  function buildTaskItem(task) {
    const customer = task.customerId ? customerById(task.customerId) : null;
    const typeMeta = task.type !== "custom" ? KANTEI[task.type] : null;

    const title = task.type === "custom"
      ? task.title
      : `${customer ? customer.name + "さん｜" : ""}${typeMeta.label}`;

    // スケジュール表示（完了時は「✅ 完了」で分かりやすく）
    const meta = el("div", { class: "task-meta" });
    if (typeMeta) meta.append(el("span", { class: "badge " + typeMeta.badge }, typeMeta.label));
    if (task.schedule === "daily") {
      meta.append(el("span", { class: "due" }, "🔁 毎日"));
    } else if (task.completed) {
      meta.append(el("span", { class: "due is-done-due" }, "✅ 完了"));
    } else if (task.dueDate) {
      meta.append(el("span", {
        class: "due" + (isOverdue(task.dueDate, task.completed) ? " is-overdue" : ""),
      }, "📅 " + formatDate(task.dueDate)));
    }

    return el("li", { class: "task-item" + (task.completed ? " is-done" : "") },
      el("input", {
        type: "checkbox", class: "task-check", checked: task.completed,
        onchange: () => toggleTask(task.id),
      }),
      el("div", { class: "task-main", onclick: () => openTaskDetail(task.id) },
        el("div", { class: "task-title" }, title),
        meta.children.length ? meta : null,
      ),
      el("div", { class: "row-actions" },
        el("button", { class: "btn btn-sm", onclick: () => openTaskForm(task.id) }, "編集"),
        el("button", { class: "btn btn-sm btn-danger", onclick: () => deleteTask(task.id) }, "削除"),
      ),
    );
  }

  function renderTaskColumn(listEl, emptyEl, tasks) {
    listEl.replaceChildren();
    emptyEl.style.display = tasks.length ? "none" : "block";
    tasks.forEach((t) => listEl.append(buildTaskItem(t)));
  }

  function renderTasks() {
    // 未完了を上に、その後は作成日時順
    const sortFn = (a, b) =>
      a.completed !== b.completed ? (a.completed ? 1 : -1) : a.createdAt - b.createdAt;

    const today = todayISO();
    // 毎日のタスク = スケジュール「毎日」／今日のタスク = 期限が今日のもの。それ以外は非表示
    const dailyTasks = state.tasks.filter((t) => t.schedule === "daily").sort(sortFn);
    const todayTasks = state.tasks
      .filter((t) => t.schedule !== "daily" && t.dueDate === today).sort(sortFn);

    renderTaskColumn(dailyList, dailyEmpty, dailyTasks);
    renderTaskColumn(todayList, todayEmpty, todayTasks);
  }

  function toggleTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (t) { t.completed = !t.completed; save(); renderTasks(); renderCalendar(); }
  }

  function deleteTask(id) {
    if (!confirm("このタスクを削除しますか？")) return;
    state.tasks = state.tasks.filter((x) => x.id !== id);
    save();
    renderTasks();
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
      el("input", { type: "date", name: "dueDate", value: data.dueDate || "" }),
    );

    function refreshUI() {
      typeSeg.querySelectorAll(".seg-option").forEach((o) =>
        o.classList.toggle("is-selected", o.dataset.value === currentType));
      const isCustom = currentType === "custom";
      // 鑑定タスク（無料鑑定/本鑑定/アップセル）は「期限」のみ
      if (!isCustom) schedule = "deadline";
      scheduleSeg.querySelectorAll(".seg-option").forEach((o) =>
        o.classList.toggle("is-selected", o.dataset.value === schedule));
      titleField.style.display = isCustom ? "block" : "none";
      customerNameField.style.display = isCustom ? "none" : "block";
      contentField.style.display = isCustom ? "none" : "block";
      scheduleField.style.display = isCustom ? "block" : "none";
      dueField.style.display = (isCustom ? schedule === "deadline" : true) ? "block" : "none";
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

    form.append(
      el("div", { class: "field" }, el("label", {}, "種別"), typeSeg),
      titleField,
      customerNameField,
      contentField,
      scheduleField,
      dueField,
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

      // 鑑定タスクは顧客を find-or-create し、顧客管理へ自動登録
      let customerId = "";
      if (currentType !== "custom") {
        const customer = findOrCreateCustomer(String(fd.get("customerName")));
        customer.kanteiTypes[currentType] = true;
        customer.results[currentType] = String(fd.get("content") || "");
        customerId = customer.id;
      }

      const payload = {
        type: currentType,
        title: currentType === "custom" ? String(fd.get("title")).trim() : "",
        customerId,
        schedule,
        dueDate: schedule === "deadline" ? String(fd.get("dueDate") || "") : "",
      };

      if (editing) {
        Object.assign(editing, payload);
      } else {
        state.tasks.push({ id: uid(), completed: false, createdAt: Date.now(), ...payload });
      }
      save();
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
  function renderCustomers() {
    customerList.replaceChildren();
    customerEmpty.style.display = state.customers.length ? "none" : "block";

    for (const c of state.customers) {
      const badges = el("div", { class: "task-meta" });
      KANTEI_KEYS.forEach((k) => {
        if (c.kanteiTypes && c.kanteiTypes[k]) {
          badges.append(el("span", { class: "badge " + KANTEI[k].badge }, KANTEI[k].label));
        }
      });

      const item = el("li", { class: "customer-item", onclick: () => openCustomerForm(c.id) },
        el("div", { class: "customer-info" },
          // 顧客名 ＋ フェーズ
          el("div", { class: "customer-line" },
            el("span", { class: "customer-name" }, c.name),
            el("span", { class: "badge badge-phase" }, c.phase || PHASES[0]),
          ),
          // LTV ＋ 鑑定タイプ
          el("div", { class: "customer-sub" },
            el("span", { class: "ltv" }, "LTV " + formatYen(c.ltv)),
            badges.children.length ? badges : null,
          ),
        ),
        el("div", { class: "row-actions" },
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
      customerList.append(item);
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
      name: "", phase: PHASES[0], ltv: 0,
      kanteiTypes: { free: false, honkan: false, upsell: false },
      results: { free: "", honkan: "", upsell: "" }, memo: "",
    };

    const form = el("form", {});

    // 鑑定タイプのチェック（人ごとに選択）
    const typeChecks = el("div", {});
    const checkInputs = {};
    KANTEI_KEYS.forEach((k) => {
      const input = el("input", { type: "checkbox", checked: data.kanteiTypes && data.kanteiTypes[k] });
      checkInputs[k] = input;
      typeChecks.append(el("label", { class: "check-row" }, input, KANTEI[k].label));
    });

    // フェーズ
    const phaseSelect = el("select", { name: "phase" },
      ...PHASES.map((p) => el("option", { value: p, selected: p === (data.phase || PHASES[0]) }, p)));

    form.append(
      el("div", { class: "field" },
        el("label", {}, "顧客名"),
        el("input", { type: "text", name: "name", value: data.name || "", placeholder: "例：山田 花子", required: true }),
      ),
      el("div", { class: "field" },
        el("label", {}, "フェーズ"),
        phaseSelect,
      ),
      el("div", { class: "field" },
        el("label", {}, "LTV（累計売上・円）"),
        el("input", { type: "number", name: "ltv", min: "0", step: "1", value: data.ltv || 0 }),
      ),
      el("div", { class: "field" },
        el("label", {}, "この顧客で扱う鑑定タイプ"),
        typeChecks,
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

      const kanteiTypes = {};
      KANTEI_KEYS.forEach((k) => { kanteiTypes[k] = checkInputs[k].checked; });
      const phase = String(fd.get("phase") || PHASES[0]);
      const ltv = Math.max(0, Number(fd.get("ltv")) || 0);

      if (editing) {
        editing.name = name;
        editing.phase = phase;
        editing.ltv = ltv;
        editing.kanteiTypes = kanteiTypes;
        editing.memo = String(fd.get("memo") || "");
      } else {
        state.customers.push({
          id: uid(), createdAt: Date.now(), name, phase, ltv, kanteiTypes,
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
      body.append(
        el("div", { class: "result-block" },
          el("div", { class: "result-head" },
            el("span", { class: "badge " + KANTEI[type].badge }, KANTEI[type].label + "結果")),
          ta,
        ),
        el("div", { class: "modal-actions" },
          el("button", { type: "button", class: "btn", onclick: () => openCustomerResults(id) }, "戻る"),
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

  // ---------------------------------------------------------
  // イベント結線 & 初期描画
  // ---------------------------------------------------------
  $("#new-task-btn").addEventListener("click", () => openTaskForm());
  $("#new-customer-btn").addEventListener("click", () => openCustomerForm());
  $("#cal-prev").addEventListener("click", () => { calRef.setMonth(calRef.getMonth() - 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { calRef.setMonth(calRef.getMonth() + 1); renderCalendar(); });

  applyTheme();
  renderTasks();
  renderCustomers();
  renderCalendar();
})();
