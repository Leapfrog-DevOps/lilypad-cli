/*
  Lilypad web client.

  Talks to the platform exactly like the CLI: POST a JSON body to the platform URL with the access
  key in X-Lilypad-Key; replies are {ok, message, data, errors}. Everything rendered from the
  platform goes through textContent (never innerHTML). The platform URL and key are kept in
  localStorage; the GitHub access value (token, deploy key or "public") is sent once and never stored.

  Views (hash routes): #/welcome (onboarding), #/demos, #/demo/<name>?tab=overview|logs|build|settings
  (detail drawer over the dashboard), #/new, #/edit/<name>, #/help (also public, no key needed), #/settings.
*/
"use strict";
(function () {
  // ---------------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------------
  const K = { url: "lilypad.url", key: "lilypad.key", refresh: "lilypad.refresh", tracked: "lilypad.tracked", theme: "lilypad.theme" };
  const EMAIL_DOMAIN = "lftechnology.com";
  const NAME_RE = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/;
  const CLIENT_RE = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;
  const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
  const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
  const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
  const RESERVED = new Set(["www", "api", "admin", "app", "mail", "status", "help", "test", "core", "dns"]);
  const BUSY = new Set(["BUILDING", "DEPLOYING", "REDEPLOYING", "DESTROYING"]);
  const ACTIVE = new Set(["BUILDING", "DEPLOYING", "RUNNING", "REDEPLOYING"]);
  const DAY = 86400000;
  const TTL_DAYS = 30;
  // The platform frees a deploy whose stack has ended; after this long redeploy/destroy are allowed anyway.
  const STUCK_MINUTES = 30;
  const isStuck = (d) => !!d && (d.status === "DEPLOYING" || d.status === "REDEPLOYING") && !!d.updatedAt &&
    Date.now() - Date.parse(d.updatedAt) > STUCK_MINUTES * 60000;
  // Fallback only: the platform's whoami reports the caller's role and cap (user 5, sales 25, elite 50, admin 50 at the time of writing).
  const ROLE_CAPS = { user: 5, sales: 25, elite: 50, admin: 50 };
  const myCap = () => (S.me && Number.isInteger(S.me.cap) && S.me.cap > 0 ? S.me.cap : ROLE_CAPS[myRole()] || ROLE_CAPS.user);
  const DEFAULT_REFRESH = 300000;
  const REFRESH_OPTS = [[0, "Off"], [10000, "10s"], [30000, "30s"], [60000, "1m"], [120000, "2m"], [180000, "3m"], [300000, "5m"], [600000, "10m"]];
  const SIZES = [
    { id: "tiny", spec: "0.25 vCPU · 512 MiB", d: "Static sites, small APIs", def: true },
    { id: "small", spec: "0.5 vCPU · 1 GiB", d: "Most demos" },
    { id: "medium", spec: "1 vCPU · 2 GiB", d: "Heavier apps" },
    { id: "large", spec: "2 vCPU · 4 GiB", d: "Admins only", admin: true },
  ];
  const STATUS_LABEL = {
    RUNNING: "Live", BUILDING: "Building", DEPLOYING: "Deploying", REDEPLOYING: "Updating", DESTROYING: "Removing",
    CONFIGURED: "Ready to deploy", FAILED: "Failed", DESTROYED: "Destroyed", UNKNOWN: "Checking",
  };
  const STAGE_DEFAULT = {
    BUILDING: "Building the image", DEPLOYING: "Creating the service", REDEPLOYING: "Building the new version",
    DESTROYING: "Tearing everything down", RUNNING: "Starting containers and passing health checks",
  };

  // ---------------------------------------------------------------------------------------------
  // Storage (localStorage when available, memory otherwise)
  // ---------------------------------------------------------------------------------------------
  const mem = {};
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v === null ? (mem[k] || "") : v; } catch (e) { return mem[k] || ""; } },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* memory only */ } },
    del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { /* memory only */ } },
  };

  // ---------------------------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------------------------
  const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "readOnly", "tabIndex", "type"]);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") Object.assign(el.style, v);
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (PROPS.has(k)) el[k] = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === "") continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#" + name);
    s.append(u);
    return s;
  }
  function logoMark() {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 48 48");
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#logo");
    u.setAttribute("width", "48");
    u.setAttribute("height", "48");
    s.append(u);
    return s;
  }
  function brand(by) {
    return h("a", { class: "brand", href: "#/demos", "aria-label": "Lilypad home" }, logoMark(),
      h("span", null, h("span", { class: "wordmark", text: "lilypad" }), by ? h("span", { class: "wordmark-by", text: "by Leapfrog" }) : null));
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function safeHttps(u) { return typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ""; }
  function btn(label, opts) {
    opts = opts || {};
    return h(opts.href ? "a" : "button", {
      class: "btn " + (opts.cls || ""), type: opts.href ? null : "button", href: opts.href || null,
      target: opts.external ? "_blank" : null, rel: opts.external ? "noopener noreferrer" : null,
      onclick: opts.onclick || null, disabled: opts.disabled || null, "aria-label": opts.aria || null, title: opts.title || null,
    }, opts.icon ? icon(opts.icon, opts.iconCls) : null, label ? h("span", { text: label }) : null);
  }
  function busyBtn(b, on) { if (!b) return; b.classList.toggle("loading", !!on); b.disabled = !!on; }

  // ---------------------------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------------------------
  const rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
  function ts(iso) { const t = Date.parse(iso || ""); return isNaN(t) ? null : t; }
  function daysLeft(iso) { const t = ts(iso); return t === null ? null : Math.ceil((t - Date.now()) / DAY); }
  function fmtDate(iso) { const t = ts(iso); return t === null ? "" : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
  function fmtDateTime(iso) { const t = ts(iso); return t === null ? "" : new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function fmtRel(iso) {
    const t = ts(iso); if (t === null) return "";
    const diff = t - Date.now(), a = Math.abs(diff);
    if (!rtf) return fmtDate(iso);
    if (a < 3600000) return rtf.format(Math.round(diff / 60000), "minute");
    if (a < DAY) return rtf.format(Math.round(diff / 3600000), "hour");
    return rtf.format(Math.round(diff / DAY), "day");
  }
  function initials(s) {
    const parts = String(s || "?").split("@")[0].split(/[.\-_ ]/).filter(Boolean);
    return ((parts[0] || "?")[0] + ((parts[1] || "")[0] || "")).toUpperCase();
  }
  function errText(r) {
    let m = r.message || ("Request failed (HTTP " + r.code + ")");
    if (r.errors && typeof r.errors === "object") {
      const parts = Object.keys(r.errors).map((k) => k + ": " + r.errors[k]);
      if (parts.length) m += "\n" + parts.join("\n");
    }
    return m;
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  const S = {
    cfg: { apiUrl: "", demoDomain: "" },
    me: null,
    authBad: false,
    demos: new Map(),
    loaded: false,
    refreshing: false,
    lastUpdated: 0,
    listError: "",
    filter: { q: "", client: "" },
    page: "",
    timer: null,
    drawer: null,
    wiz: null,
    onb: { step: "", email: "", sent: false, error: "" },
    menu: null,
    lastFocus: null,
  };
  const apiUrl = () => store.get(K.url) || S.cfg.apiUrl;
  const hasKey = () => !!store.get(K.key);
  const myEmail = () => (S.me && S.me.email ? S.me.email.toLowerCase() : "");
  const isAdmin = () => !!(S.me && S.me.admin);
  // Older platforms send only `admin`. Sales and elite differ from user only in the cap.
  const myRole = () => (!S.me ? "user" : S.me.role || (S.me.admin ? "admin" : "user"));
  const roleLabel = () => ({ admin: "Admin", elite: "Elite", sales: "Sales" })[myRole()] || "";
  const toMe = (d) => ({ email: d.email, keyExpiresAt: d.keyExpiresAt || "", admin: d.admin === true, role: d.role, cap: d.cap });
  // Editing is creator-only and hidden on other people's demos; deploy and redeploy are open to admins too.
  // Unknown owner counts as mine.
  const isMine = (d) => !d.owner || !myEmail() || d.owner.toLowerCase() === myEmail();
  const canDeploy = (d) => isMine(d) || isAdmin();
  const adminTag = () => (roleLabel() ? h("span", { class: "tag " + myRole(), text: roleLabel() }) : null);

  function demoDomain() {
    if (S.cfg.demoDomain) return S.cfg.demoDomain;
    const host = location.hostname;
    if (host && host.split(".").length >= 3 && !/^[\d.]+$/.test(host)) return host.split(".").slice(1).join(".");
    for (const d of S.demos.values()) {
      const u = safeHttps(d.url);
      if (u) { const hn = new URL(u).hostname.split("."); if (hn.length >= 3) return hn.slice(1).join("."); }
    }
    return "";
  }

  // ---------------------------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------------------------
  async function api(body) {
    const url = apiUrl();
    if (!url) return { code: 0, ok: false, message: "No platform URL set. Add it in Settings." };
    const headers = { "Content-Type": "application/json" };
    const key = store.get(K.key);
    if (key && body.action !== "auth") headers["X-Lilypad-Key"] = key;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) {
      return { code: 0, ok: false, message: "Can't reach the platform. Check your connection, or the platform URL in Settings." };
    }
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
    const out = j && typeof j === "object" && !Array.isArray(j) ? j : { message: txt };
    out.code = res.status;
    out.ok = res.ok && out.ok !== false;
    if (res.status === 401 && body.action !== "auth" && !S.authBad) { S.authBad = true; renderGlobalAlert(); }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Toasts, copy, menus, modal
  // ---------------------------------------------------------------------------------------------
  function toast(msg, kind, ms) {
    kind = kind || "ok";
    let gone = false;
    const t = h("div", { class: "toast " + kind, role: kind === "err" ? "alert" : "status" },
      icon(kind === "err" ? "i-alert" : kind === "info" ? "i-info" : "i-check"),
      h("div", { class: "t-body", text: msg }),
      h("button", { type: "button", "aria-label": "Dismiss", onclick: () => close() }, icon("i-x", "icon-s")));
    function close() { if (gone) return; gone = true; t.classList.add("out"); setTimeout(() => t.remove(), 220); }
    $("#toasts").append(t);
    setTimeout(close, ms || (kind === "err" ? 8000 : 4500));
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(what || "Copied", "ok", 2200); }
    catch (e) { toast("Couldn't copy. Select and copy it by hand.", "err"); }
  }

  function closeMenu() {
    if (!S.menu) return;
    S.menu.el.remove();
    if (S.menu.host) S.menu.host.classList.remove("menu-open");
    S.menu.anchor.setAttribute("aria-expanded", "false");
    S.menu = null;
  }
  function openMenu(anchor, items, opts) {
    const same = S.menu && S.menu.anchor === anchor;
    closeMenu();
    if (same) return;
    opts = opts || {};
    const m = h("div", { class: "menu", role: "menu" });
    if (opts.head) m.append(opts.head);
    for (const it of items) {
      if (it === "-") { m.append(h("hr")); continue; }
      if (!it) continue;
      m.append(h("button", {
        type: "button", role: "menuitem", class: it.danger ? "danger" : null,
        onclick: (e) => { e.stopPropagation(); closeMenu(); it.run(); },
      }, icon(it.icon), h("span", { text: it.label })));
    }
    anchor.parentElement.append(m);
    const rect = anchor.getBoundingClientRect();
    if (window.innerHeight - rect.bottom < 300 && rect.top > 320) m.classList.add("up");
    const host = anchor.closest(".demo");
    if (host) host.classList.add("menu-open");
    anchor.setAttribute("aria-expanded", "true");
    S.menu = { el: m, anchor, host };
    const first = m.querySelector("button");
    if (first) first.focus();
  }
  document.addEventListener("click", (e) => { if (S.menu && !S.menu.el.contains(e.target) && !S.menu.anchor.contains(e.target)) closeMenu(); });

  function modal(opts) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      let input = null;
      const ok = btn(opts.confirm || "Confirm", { cls: opts.danger ? "btn-danger-solid" : "btn-primary" });
      const cancel = btn("Cancel", { cls: "btn-ghost" });
      if (opts.requireText) {
        input = h("input", { class: "input mono", id: "modal-input", autocomplete: "off", spellcheck: "false", placeholder: opts.requireText });
        ok.disabled = true;
        input.addEventListener("input", () => { ok.disabled = input.value.trim() !== opts.requireText; });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ok.disabled) ok.click(); });
      }
      const scrim = h("div", { class: "scrim modal-scrim" });
      const card = h("div", { class: "modal-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title" },
        h("div", { class: "modal-ico" + (opts.danger ? "" : " ok") }, icon(opts.icon || (opts.danger ? "i-warn" : "i-info"))),
        h("h2", { id: "modal-title", text: opts.title }),
        h("p", null, opts.body),
        input ? h("div", { class: "field" }, h("label", { for: "modal-input" }, "Type ", h("code", { text: opts.requireText }), " to confirm"), input) : null,
        h("div", { class: "modal-actions" }, cancel, ok));
      const wrap = h("div", { class: "modal" }, card);
      function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } }
      function done(v) { scrim.remove(); wrap.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); resolve(v); }
      ok.addEventListener("click", () => done(true));
      cancel.addEventListener("click", () => done(false));
      wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
      document.addEventListener("keydown", onKey, true);
      document.body.append(scrim, wrap);
      (input || cancel).focus();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------------------------
  function applyTheme() {
    const t = store.get(K.theme);
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }

  // ---------------------------------------------------------------------------------------------
  // Tracked names: demos set up or opened in this browser. `list` returns every demo that isn't
  // DESTROYED, but older platforms return only active ones, and admins may open others' demos by name.
  // ---------------------------------------------------------------------------------------------
  function tracked() {
    try { const a = JSON.parse(store.get(K.tracked) || "[]"); return Array.isArray(a) ? a.filter((n) => NAME_RE.test(n)) : []; }
    catch (e) { return []; }
  }
  function track(name) { const a = tracked(); if (a.indexOf(name) < 0) { a.push(name); store.set(K.tracked, JSON.stringify(a)); } }
  function untrack(name) { store.set(K.tracked, JSON.stringify(tracked().filter((n) => n !== name))); }

  // ---------------------------------------------------------------------------------------------
  // Demo data
  // ---------------------------------------------------------------------------------------------
  // Notes are free text from the demo's creator: always rendered with textContent, never as HTML.
  const MAX_NOTES = 1000;
  // Same as the server's list preview: one line, at most `limit` characters, an ellipsis when cut.
  function notesPreview(notes, limit) {
    limit = limit || 40;
    const flat = String(notes || "").split(/\s+/).filter(Boolean).join(" ");
    return flat.length <= limit ? flat : flat.slice(0, limit - 1).trimEnd() + "\u2026";
  }
  function rowFromStatus(d) {
    return {
      name: d.name, client: d.client || "", status: d.status, owner: d.ownerEmail || "", url: d.url || "",
      expiresAt: d.expiresAt || "", permanent: !!d.permanent, settled: d.settled, stage: d.stage || "", full: d,
      notes: notesPreview(d.notes),
    };
  }
  function category(d) {
    if (d.status === "RUNNING") return d.settled === false ? "busy" : "live";
    if (BUSY.has(d.status)) return "busy";
    if (d.status === "FAILED") return "fail";
    if (d.status === "CONFIGURED") return "idle";
    return "unknown";
  }
  function statusLabel(d) {
    if (d.status === "RUNNING" && d.settled === false) return "Starting";
    return STATUS_LABEL[d.status] || STATUS_LABEL.UNKNOWN;
  }
  function needsWatch(d) { return BUSY.has(d.status) || d.settled === false || !d.status || d.status === "UNKNOWN"; }

  async function listDemos() {
    const r = await api({ action: "list" });
    if (!r.ok) { S.listError = r.code === 401 ? "" : errText(r); return false; }
    S.listError = "";
    const next = new Map();
    for (const row of Array.isArray(r.data) ? r.data : []) {
      if (!row || !row.name) continue;
      const prev = S.demos.get(row.name);
      const keep = prev && prev.status === row.status;
      next.set(row.name, {
        name: row.name, client: row.client || "", status: row.status, owner: row.owner || "", url: row.url || "", expiresAt: row.expiresAt || "",
        notes: typeof row.notes === "string" ? row.notes : "",
        permanent: !!row.permanent, settled: keep ? prev.settled : undefined, stage: keep ? prev.stage : "", full: keep ? prev.full : null,
      });
    }
    for (const n of tracked()) if (!next.has(n)) next.set(n, S.demos.get(n) || { name: n, status: "UNKNOWN" });
    S.demos = next;
    return true;
  }

  async function refreshOne(name) {
    const r = await api({ action: "status", name });
    if (r.code === 404 || r.code === 403 || (r.data && r.data.status === "DESTROYED")) {
      untrack(name);
      S.demos.delete(name);
    } else if (r.ok && r.data) {
      S.demos.set(name, rowFromStatus(r.data));
    }
    return r;
  }

  async function refreshAll(opts) {
    if (S.refreshing || !apiUrl() || !hasKey()) return;
    S.refreshing = true;
    setRefreshSpin(true);
    try {
      const ok = await listDemos();
      if (ok) {
        const names = [];
        for (const d of S.demos.values()) {
          if (needsWatch(d) || (opts && opts.deep && d.status === "RUNNING" && d.settled === undefined)) names.push(d.name);
        }
        await Promise.all(names.map(refreshOne));
        S.lastUpdated = Date.now();
      }
      S.loaded = true;
    } finally {
      S.refreshing = false;
      setRefreshSpin(false);
      updateDemos();
      if (S.drawer) refreshDrawerHead();
    }
  }
  function setRefreshSpin(on) {
    const b = $("#refresh-now");
    if (b) { const i = b.querySelector("svg"); if (i) i.classList.toggle("spin", on); b.disabled = on; }
  }

  function refreshMs() {
    const raw = store.get(K.refresh);
    const v = parseInt(raw, 10);
    return raw !== "" && REFRESH_OPTS.some((o) => o[0] === v) ? v : DEFAULT_REFRESH;
  }
  function schedule() {
    clearInterval(S.timer);
    S.timer = null;
    const ms = refreshMs();
    if (ms > 0) S.timer = setInterval(() => { if (!document.hidden) refreshAll(); }, ms);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.timer && Date.now() - S.lastUpdated > 15000) refreshAll(); });

  // ---------------------------------------------------------------------------------------------
  // Lifecycle actions
  // ---------------------------------------------------------------------------------------------
  const ACTION_DONE = {
    create: (n) => "Deploying " + n + ". Usually 5–10 minutes; you'll get an email when it's live.",
    redeploy: (n) => "Redeploying " + n + " from the latest commit. The current version keeps serving until the new one is healthy.",
    destroy: (n) => "Removing " + n + ". It'll be gone in a minute or two.",
    pin: (n) => "Making " + n + " permanent. Its expiry goes away in a minute or so.",
    unpin: (n) => n + " is going back to a 30-day lifetime.",
  };
  async function runAction(action, name, b) {
    if (action === "destroy") {
      const yes = await modal({
        title: "Destroy " + name + "?", danger: true, confirm: "Destroy demo", requireText: name, icon: "i-trash",
        body: "This deletes the demo, its service and its images. It cannot be undone, and the name becomes free for anyone.",
      });
      if (!yes) return null;
    }
    if (action === "pin" || action === "unpin") {
      const yes = await modal(action === "pin"
        ? { title: "Make " + name + " permanent?", confirm: "Make permanent", icon: "i-pin",
            body: "It will never expire and nobody, admins included, can destroy it until an admin unpins it. It won't count toward its creator's demo limit." }
        : { title: "Unpin " + name + "?", confirm: "Unpin", icon: "i-pin",
            body: "It goes back to a normal 30-day lifetime from today, with the usual warning email, and can be destroyed again." });
      if (!yes) return null;
    }
    const owner = (S.demos.get(name) || {}).owner;
    if ((action === "create" || action === "redeploy") && isAdmin() && !isMine({ owner })) {
      const verb = action === "create" ? "Deploy" : "Redeploy";
      const yes = await modal({
        title: verb + " " + name + " for " + owner + "?", confirm: verb, icon: action === "create" ? "i-rocket" : "i-redo",
        body: "This is " + owner + "'s demo. It stays theirs and they get a note; the result comes to you.",
      });
      if (!yes) return null;
    }
    busyBtn(b, true);
    const r = await api({ action, name });
    busyBtn(b, false);
    if (!r.ok) { toast(errText(r), "err"); return r; }
    toast(ACTION_DONE[action] ? ACTION_DONE[action](name) : (r.message || "Done"), "ok", 6000);
    if (action !== "destroy") track(name);
    await refreshOne(name);
    updateDemos();
    if (S.drawer && S.drawer.name === name) { if (action === "destroy") go("demos"); else loadDrawer(); }
    return r;
  }

  // ---------------------------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------------------------
  function route() {
    const raw = location.hash.replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    const path = qi < 0 ? raw : raw.slice(0, qi);
    const parts = path.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
    return { view: parts[0] || "demos", arg: parts[1] || "", q: new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1)) };
  }
  // Setting the hash it already has fires no hashchange (onboarding runs under #/demos), so render directly.
  function go(path) { const want = "#/" + path; if (location.hash === want) render(); else location.hash = want; }
  window.addEventListener("hashchange", render);

  function render() {
    closeMenu();
    const r = route();
    if (r.view === "help" && (!apiUrl() || !hasKey())) { if (S.drawer) closeDrawer(true); renderPublicHelp(); return; }
    if (!apiUrl() || !hasKey() || r.view === "welcome") { if (S.drawer) closeDrawer(true); renderOnboarding(r); return; }
    const pageKey = r.view === "demo" ? "demos" : r.view + "/" + r.arg + "?" + r.q.toString();
    if (!$(".topbar") || S.page !== pageKey) {
      S.page = pageKey;
      renderShell(r);
    }
    updateNav(r);
    if (r.view === "demo" && r.arg) openDrawer(r.arg, r.q.get("tab") || "overview");
    else if (S.drawer) closeDrawer(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------------------------
  function renderShell(r) {
    const app = clear($("#app"));
    if (S.drawer) closeDrawer(true);
    app.append(topbar(), h("div", { id: "global-alert" }), h("main", { class: "page", id: "main", tabindex: "-1" }), h("div", { id: "drawer-root" }));
    renderGlobalAlert();
    const main = $("#main");
    if (r.view === "demos" || r.view === "demo") renderDemos(main);
    else if (r.view === "new") renderWizard(main, null);
    else if (r.view === "edit" && NAME_RE.test(r.arg)) renderWizard(main, r.arg);
    else if (r.view === "help") renderHelp(main, true);
    else if (r.view === "settings") renderSettings(main);
    else { go("demos"); return; }
    window.scrollTo(0, 0);
  }

  function topbar() {
    const email = myEmail();
    const userBtn = h("button", { class: "userbtn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", id: "userbtn" },
      h("span", { class: "avatar", text: initials(email || "?") }), h("span", { class: "email", text: email || "Account" }),
      h("span", { class: "tag " + myRole(), id: "admin-badge", text: roleLabel(), hidden: !roleLabel() }));
    userBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const exp = S.me && S.me.keyExpiresAt;
      openMenu(userBtn, [
        { icon: "i-sliders", label: "Settings", run: () => go("settings") },
        { icon: "i-help", label: "Help & guide", run: () => go("help") },
        { icon: "i-key", label: "Email me my key", run: () => go("welcome?step=email") },
        "-",
        { icon: "i-logout", label: "Sign out", danger: true, run: signOut },
      ], { head: h("div", { class: "menu-head" }, h("span", { class: "eyebrow", text: "Signed in as" }), h("strong", { text: myEmail() || "unknown" }),
        isAdmin() ? h("span", { class: "hint", text: "Admin: you can see, deploy, redeploy, extend and destroy every demo." }) : null,
        myRole() === "sales" || myRole() === "elite" ? h("span", { class: "hint", text: roleLabel() + ": you can have up to " + myCap() + " active demos." }) : null,
        exp ? h("span", { class: "hint", text: "Key expires " + fmtRel(exp) + " (" + fmtDate(exp) + ")" }) : null) });
    });
    return h("header", { class: "topbar" }, h("div", { class: "topbar-in" },
      brand(true),
      h("nav", { class: "mainnav", "aria-label": "Main" },
        h("a", { href: "#/demos", "data-nav": "demos" }, icon("i-layers"), h("span", { text: "Demos" })),
        h("a", { href: "#/new", "data-nav": "new" }, icon("i-plus"), h("span", { text: "New demo" })),
        h("a", { href: "#/help", "data-nav": "help" }, icon("i-help"), h("span", { text: "Help" }))),
      h("div", { class: "spacer" }),
      h("div", { class: "usermenu" }, userBtn)));
  }
  function updateNav(r) {
    const active = r.view === "demo" ? "demos" : r.view;
    document.querySelectorAll(".mainnav a").forEach((a) => {
      if (a.getAttribute("data-nav") === active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const ub = $("#userbtn");
    if (ub && S.me) { $(".avatar", ub).textContent = initials(S.me.email); $(".email", ub).textContent = S.me.email; const b = $("#admin-badge"); b.hidden = !roleLabel(); b.textContent = roleLabel(); b.className = "tag " + myRole(); }
  }
  function renderGlobalAlert() {
    const root = $("#global-alert");
    if (!root) return;
    clear(root);
    let node = null;
    if (S.authBad) {
      node = h("div", { class: "alert alert-warn", role: "alert" }, icon("i-key"),
        h("div", { class: "alert-body" }, h("strong", { text: "Your access key isn't valid anymore" }),
          "It expired or was replaced by a newer one. Ask for your key again to keep going."),
        btn("Email me my key", { cls: "btn-sm", onclick: () => go("welcome?step=email") }));
    } else if (S.me && S.me.keyExpiresAt) {
      const d = daysLeft(S.me.keyExpiresAt);
      if (d !== null && d <= 3) {
        node = h("div", { class: "alert alert-info" }, icon("i-clock"),
          h("div", { class: "alert-body" }, h("strong", { text: "Your access key expires " + fmtRel(S.me.keyExpiresAt) }),
            "Request a new one before it runs out. The new key replaces this one."),
          btn("Renew key", { cls: "btn-sm", onclick: () => { S.onbNew = true; go("welcome?step=email"); } }));
      }
    }
    if (node) root.append(h("div", { class: "global-alert" }, node));
  }
  async function whoami() {
    if (!apiUrl() || !hasKey()) return null;
    const r = await api({ action: "whoami" });
    if (r.ok && r.data && r.data.email) { S.me = toMe(r.data); S.authBad = false; }
    renderGlobalAlert();
    updateNav(route());
    updateDemos();
    return r;
  }
  async function signOut() {
    const yes = await modal({ title: "Sign out?", confirm: "Sign out", icon: "i-logout",
      body: "This removes your key from this browser. The key stays valid until it expires or you request a new one." });
    if (!yes) return;
    store.del(K.key);
    S.me = null; S.demos = new Map(); S.loaded = false; S.authBad = false;
    S.onb = { step: "email", email: "", sent: false, error: "" };
    toast("Signed out", "info", 2500);
    go("welcome");
  }

  // ---------------------------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------------------------
  function renderOnboarding(r) {
    const app = clear($("#app"));
    S.page = "";
    const want = r.q.get("step");
    if (!apiUrl()) S.onb.step = "connect";
    else if (want === "email" || want === "key") { if (!(S.onb.step === "key" && want === "email" && S.onb.sent)) S.onb.step = want; }
    else if (!S.onb.step || S.onb.step === "connect") S.onb.step = hasKey() && !S.authBad ? "done" : "email";

    const hero = h("section", { class: "onb-hero" },
      brand(true),
      h("div", { class: "onb-copy" },
        h("p", { class: "eyebrow", text: "Leapfrog · Self-serve demos" }),
        h("h1", null, "From repo to ", h("em", { text: "live demo" }), " in minutes."),
        h("p", { text: "Point Lilypad at a GitHub repo with a Dockerfile. It builds it, runs it and hands you an HTTPS link to share with your client." }),
        h("ul", { class: "onb-points" },
          h("li", null, h("span", { class: "pt" }, icon("i-zap")), h("span", null, "One shareable link per demo: ", h("strong", { text: "https://<name>." + (demoDomain() || "<demo domain>") }))),
          h("li", null, h("span", { class: "pt" }, icon("i-shield")), h("span", { text: "Your company email is your login. No passwords." })),
          h("li", null, h("span", { class: "pt" }, icon("i-clock")), h("span", { text: "Cleans up after 30 days. Extend when you need more time." })))),
      h("p", { class: "onb-foot", text: "Leapfrog Technology · Internal tool" }));
    const main = h("section", { class: "onb-main" }, h("div", { class: "onb-card", id: "onb-card" }));
    app.append(h("div", { class: "onb" }, hero, main));
    renderOnbStep();
  }

  function onbSteps() { return (S.cfg.apiUrl ? [] : ["connect"]).concat(["email", "key"]); }

  function renderOnbStep() {
    const card = clear($("#onb-card"));
    const steps = onbSteps();
    const done = S.onb.step === "done";
    const idx = done ? steps.length : Math.max(0, steps.indexOf(S.onb.step));
    card.append(h("div", { class: "onb-progress", "aria-hidden": "true" }, steps.map((_, i) => h("i", { class: i < idx || (!done && i === idx) ? "on" : "" }))));
    const step = h("div", { class: "onb-step" });
    card.append(step);
    if (!done) step.append(h("p", { class: "step-of", text: "Step " + (idx + 1) + " of " + steps.length }));
    const err = S.onb.error ? h("div", { class: "alert alert-err mt-16", role: "alert" }, icon("i-alert"), h("div", { class: "alert-body", text: S.onb.error })) : null;
    S.onb.error = "";
    ({ connect: onbConnect, email: onbEmail, key: onbKey, done: onbDone }[S.onb.step] || onbEmail)(step, err);
    card.append(h("p", { class: "onb-help" }, icon("i-help", "icon-s"), "New to Lilypad? ",
      h("button", { class: "linklike", type: "button", text: "How to set up and deploy", onclick: helpModal })));
    const first = step.querySelector("input");
    if (first) first.focus();
  }
  function onbGo(step, error) { S.onb.step = step; S.onb.error = error || ""; renderOnbStep(); }
  // Back to the previous onboarding step; none on the first one.
  function onbBack() {
    const steps = onbSteps(), i = steps.indexOf(S.onb.step);
    if (i <= 0) return null;
    return btn("Back", { cls: "btn-ghost btn-lg", icon: "i-left", onclick: () => onbGo(steps[i - 1]) });
  }

  function validPlatformUrl(u) {
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/.test(u);  // only for testing against a local mock
    return !/[\s"']/.test(u) && (/^https:\/\/\S+$/.test(u) || local);
  }

  function onbConnect(root, err) {
    const input = h("input", { class: "input", id: "onb-url", type: "url", placeholder: "https://…", autocomplete: "off", spellcheck: "false", value: store.get(K.url) });
    const next = btn("Continue", { cls: "btn-primary btn-lg" });
    next.append(icon("i-right"));
    const submit = () => {
      const u = input.value.trim();
      if (!validPlatformUrl(u)) { onbGo("connect", "Enter the full https:// address your Lilypad admin gave you."); return; }
      store.set(K.url, u);
      onbGo("email");
    };
    next.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    add(root, [
      h("h2", { text: "Connect to Lilypad" }),
      h("p", { class: "lead", text: "Paste the platform address from your Lilypad admin. You only do this once on this browser." }),
      h("div", { class: "field" }, h("label", { for: "onb-url", text: "Platform URL" }), input, h("span", { class: "hint", text: "Starts with https://. Kept in this browser only." })),
      err,
      h("div", { class: "onb-actions" }, next),
    ]);
  }

  function onbEmail(root, err) {
    const input = h("input", { class: "input", id: "onb-email", type: "email", placeholder: "you@" + EMAIL_DOMAIN, autocomplete: "email", value: S.onb.email || "" });
    const msg = h("span", { class: "err-text", "aria-live": "polite" });
    const send = btn("Email me a key", { cls: "btn-primary btn-lg", icon: "i-mail" });
    // Off: the platform mails the current key again while it is valid. On: a new key replaces it everywhere.
    const fresh = h("input", { type: "checkbox", id: "onb-new", checked: !!S.onbNew });
    fresh.addEventListener("change", () => { S.onbNew = fresh.checked; });
    const submit = async () => {
      const email = input.value.toLowerCase().replace(/\s+/g, "");
      const re = new RegExp("^[a-z0-9][a-z0-9._-]{0,63}@" + EMAIL_DOMAIN.replace(/\./g, "\\.") + "$");
      if (!re.test(email)) { input.setAttribute("aria-invalid", "true"); msg.textContent = "Use your plain @" + EMAIL_DOMAIN + " address (no + aliases)."; input.focus(); return; }
      busyBtn(send, true);
      const r = await api(fresh.checked ? { action: "auth", email, new: true } : { action: "auth", email });
      busyBtn(send, false);
      S.onb.email = email;
      if (!r.ok) { onbGo("email", errText(r)); return; }
      S.onb.sent = true;
      S.onb.reused = !!(r.data && r.data.reused);
      S.onbNew = false;
      onbGo("key");
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); msg.textContent = ""; });
    add(root, [
      h("h2", { text: "Sign in with your work email" }),
      h("p", { class: "lead", text: "We'll email you an access key. No password, nothing to install." }),
      h("div", { class: "field" }, h("label", { for: "onb-email", text: "Work email" }), input, msg,
        h("span", { class: "hint", text: "Your exact @" + EMAIL_DOMAIN + " address. Asking again sends the key you already have while it is valid." })),
      h("div", { class: "field" }, h("label", { class: "switch", for: "onb-new" }, fresh, "Send a new key instead"),
        h("span", { class: "hint", text: "Only if your key leaked: every saved copy, on any machine, stops working." })),
      err,
      h("div", { class: "onb-actions" }, onbBack(), send),
      h("p", { class: "onb-alt" }, "Already have a key? ", h("button", { class: "linklike", type: "button", text: "Paste it instead", onclick: () => onbGo("key") })),
    ]);
  }

  function onbKey(root, err) {
    const input = h("input", { class: "input mono", id: "onb-key", type: "password", placeholder: "lpk_…", autocomplete: "off", spellcheck: "false" });
    const eye = h("button", { class: "btn btn-ghost btn-icon", type: "button", "aria-label": "Show key" }, icon("i-eye"));
    eye.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      eye.setAttribute("aria-label", show ? "Hide key" : "Show key");
      clear(eye).append(icon(show ? "i-eye-off" : "i-eye"));
    });
    const verify = btn("Verify & continue", { cls: "btn-primary btn-lg", icon: "i-check" });
    const submit = async () => {
      const k = input.value.trim();
      if (!/^lpk_\S+$/.test(k)) { onbGo("key", "That doesn't look like a Lilypad key. It starts with lpk_."); return; }
      const prev = store.get(K.key);
      store.set(K.key, k);
      busyBtn(verify, true);
      const r = await api({ action: "whoami" });
      busyBtn(verify, false);
      S.authBad = false;
      if (!r.ok || !r.data) {
        if (prev) store.set(K.key, prev); else store.del(K.key);
        onbGo("key", r.code === 401 ? "That key isn't valid. It may have been replaced by a newer one; use the latest email." : errText(r));
        return;
      }
      S.me = toMe(r.data);
      onbGo("done");
    };
    verify.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    add(root, [
      h("h2", { text: "Paste your access key" }),
      h("p", { class: "lead", text: "It's in the email from Lilypad, subject “Your Lilypad access key”." }),
      S.onb.sent ? h("div", { class: "mailbox" }, icon("i-mail"), h("div", null, h("strong", { text: "Check " + S.onb.email }),
        h("div", { text: (S.onb.reused ? "We sent your current key again; copies you saved elsewhere still work. " : "We sent a new key; any older key has stopped working. ") +
          "It usually arrives within a minute. Not there? Look in spam or junk." }))) : null,
      h("div", { class: "field" }, h("label", { for: "onb-key", text: "Access key" }), h("div", { class: "input-group" }, input, eye),
        h("span", { class: "hint", text: "Starts with lpk_ and works for 30 days. Saved in this browser only." })),
      err,
      h("div", { class: "onb-actions" }, onbBack(), verify),
      h("p", { class: "onb-alt" }, "No email? ", h("button", { class: "linklike", type: "button", text: "Send it again", onclick: () => onbGo("email") }), " (one per minute)."),
    ]);
  }

  function onbDone(root) {
    const exp = S.me && S.me.keyExpiresAt;
    const finish = (path) => { S.onb = { step: "", email: "", sent: false, error: "" }; S.loaded = false; go(path); refreshAll(); };
    add(root, [
      h("div", { class: "done-badge" }, icon("i-check")),
      h("h2", { text: "You're all set" }),
      h("p", { class: "lead", text: "Lilypad is connected. Your demos will show up on the dashboard." }),
      S.me ? h("div", { class: "id-card" }, h("span", { class: "avatar", text: initials(S.me.email) }),
        h("div", null, h("strong", { text: S.me.email }), " ", adminTag(), h("div", { class: "hint", text: exp ? "Key valid until " + fmtDate(exp) : "Key verified" }))) : null,
      h("div", { class: "onb-actions" },
        btn("Create your first demo", { cls: "btn-primary btn-lg", icon: "i-rocket", onclick: () => finish("new") }),
        btn("Go to dashboard", { cls: "btn-lg", onclick: () => finish("demos") })),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------------------------
  function renderDemos(main) {
    const search = h("input", { class: "input", type: "search", id: "q", placeholder: "Search demos   /", "aria-label": "Search demos", value: S.filter.q });
    search.addEventListener("input", () => { S.filter.q = search.value.trim().toLowerCase(); updateDemos(); });
    const client = h("select", { class: "select", id: "client-filter", "aria-label": "Filter by client" });
    client.addEventListener("change", () => { S.filter.client = client.value; updateDemos(); });
    const sel = h("select", { class: "select select-sm", id: "refresh-sel", "aria-label": "Auto-refresh interval" },
      REFRESH_OPTS.map((o) => h("option", { value: String(o[0]), text: o[1], selected: o[0] === refreshMs() })));
    sel.addEventListener("change", () => { store.set(K.refresh, sel.value); schedule(); toast(sel.value === "0" ? "Auto-refresh off" : "Auto-refresh every " + sel.selectedOptions[0].text, "info", 2000); });
    const now = btn("", { cls: "btn-icon", icon: "i-refresh", aria: "Refresh now", title: "Refresh now (r)" });
    now.id = "refresh-now";
    now.addEventListener("click", () => refreshAll({ deep: true }));

    const openInput = h("input", { class: "input", placeholder: "demo-name", "aria-label": "Demo name", autocomplete: "off", spellcheck: "false" });
    const openGo = () => {
      const n = openInput.value.trim().toLowerCase();
      if (!NAME_RE.test(n)) { toast("That isn't a valid demo name.", "err", 3000); return; }
      track(n); openInput.value = ""; go("demo/" + n);
    };
    openInput.addEventListener("keydown", (e) => { if (e.key === "Enter") openGo(); });

    add(main, [
      h("div", { class: "page-head" },
        h("div", { class: "grow" }, h("h1", { id: "demos-title", text: "Demos" }), h("p", { class: "sub", id: "demos-sub", text: "Live, disposable demos built from your GitHub repos." })),
        btn("New demo", { cls: "btn-primary btn-lg", icon: "i-plus", href: "#/new" })),
      h("div", { class: "stats", id: "stats" }),
      h("div", { class: "toolbar" },
        h("div", { class: "input-icon" }, icon("i-search"), search),
        client,
        h("span", { class: "grow" }),
        h("span", { class: "updated", id: "updated", "aria-live": "polite" }),
        h("div", { class: "refresh-box", title: "Auto-refresh" }, h("span", { class: "label" }, icon("i-clock", "icon-s"), "Auto"), sel),
        now),
      h("div", { id: "list-error" }),
      h("div", { class: "grid", id: "grid" }),
      h("div", { class: "card open-strip" }, icon("i-search"),
        h("span", { class: "hint", text: "Looking for a demo that's ready to deploy or failed? The platform doesn't list those; open it by name." }),
        openInput, btn("Open", { cls: "btn-sm", onclick: openGo })),
    ]);
    updateDemos();
  }

  function filteredDemos() {
    const q = S.filter.q, c = S.filter.client;
    const rank = (d) => ({ busy: 0, fail: 1, idle: 2, live: 3, unknown: 4 })[category(d)];
    return Array.from(S.demos.values())
      .filter((d) => !c || d.client === c)
      .filter((d) => !q || [d.name, d.client, d.owner].some((v) => (v || "").toLowerCase().indexOf(q) >= 0))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  function updateDemos() {
    const grid = $("#grid");
    if (!grid) return;
    $("#demos-title").textContent = isAdmin() ? "All demos" : "Demos";
    $("#demos-sub").textContent = isAdmin() ? "You're an admin, so you see everyone's demos." : "Live, disposable demos built from your GitHub repos.";
    const all = Array.from(S.demos.values());
    const me = myEmail();
    const live = all.filter((d) => category(d) === "live").length;
    const busy = all.filter((d) => category(d) === "busy").length;
    const soon = all.filter((d) => { const n = daysLeft(d.expiresAt); return d.status === "RUNNING" && !d.permanent && n !== null && n <= 7; }).length;
    const mine = all.filter((d) => ACTIVE.has(d.status) && !d.permanent && (!me || (d.owner || "").toLowerCase() === me)).length;
    const stats = clear($("#stats"));
    const stat = (cls, ic, num, label, extra) => h("div", { class: "card stat" }, h("div", { class: "stat-ico " + cls }, icon(ic)),
      h("div", null, h("div", { class: "stat-num", text: S.loaded ? num : "–" }), h("div", { class: "stat-label", text: label }), extra || null));
    stats.append(
      stat("g", "i-globe", live, "Live"),
      stat("b", "i-activity", busy, "In progress"),
      stat("y", "i-clock", soon, "Expiring within 7 days"),
      stat("v", "i-box", Math.min(mine, myCap()) + " / " + myCap(), "Your active slots",
        myCap() <= 10 ? h("div", { class: "slots", "aria-hidden": "true" }, Array.from({ length: myCap() }, (_, i) => h("i", { class: i < mine ? "on" : "" }))) : null));

    const cf = $("#client-filter");
    if (cf) {
      const clients = Array.from(new Set(all.map((d) => d.client).filter(Boolean))).sort();
      const cur = S.filter.client;
      clear(cf).append(h("option", { value: "", text: "All clients" }), clients.map((c) => h("option", { value: c, text: c, selected: c === cur })));
      cf.hidden = clients.length === 0 && !cur;
    }
    const up = $("#updated");
    if (up) up.textContent = S.lastUpdated ? "Updated " + new Date(S.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const le = clear($("#list-error"));
    if (S.listError) le.append(h("div", { class: "alert alert-err", role: "alert", style: { marginBottom: "16px" } }, icon("i-alert"), h("div", { class: "alert-body", text: S.listError })));

    clear(grid);
    if (!S.loaded) {
      for (let i = 0; i < 3; i++) {
        grid.append(h("div", { class: "card demo", "aria-hidden": "true" },
          h("div", { class: "demo-top" }, h("div", { class: "bone h40" }), h("div", { class: "grow" }, h("div", { class: "bone l1" }), h("div", { class: "bone l2" }))),
          h("div", { class: "bone l3" }), h("div", { class: "bone l4" })));
      }
      return;
    }
    const items = filteredDemos();
    if (!items.length) {
      grid.append(all.length
        ? h("div", { class: "card empty", style: { gridColumn: "1 / -1" } },
          h("h2", { text: "No matches" }), h("p", { text: "No demo matches your search or client filter." }),
          btn("Clear filters", { onclick: () => { S.filter = { q: "", client: "" }; const q = $("#q"); if (q) q.value = ""; updateDemos(); } }))
        : h("div", { class: "card empty", style: { gridColumn: "1 / -1" } },
          h("div", { class: "empty-art" }, logoMark()),
          h("h2", { text: "No demos yet" }),
          h("p", { text: "Spin up your first one: pick a GitHub repo with a Dockerfile and Lilypad gives you a live HTTPS link in about 10 minutes." }),
          btn("Create a demo", { cls: "btn-primary btn-lg", icon: "i-rocket", href: "#/new" })));
      return;
    }
    for (const d of items) grid.append(demoCard(d));
  }

  function lifecycleTrack(d) {
    const s = d.status;
    let states;
    if (s === "CONFIGURED") states = ["done", "", "", ""];
    else if (s === "BUILDING" || s === "REDEPLOYING") states = ["done", "now", "", ""];
    else if (s === "DEPLOYING") states = ["done", "done", "now", ""];
    else if (s === "RUNNING" && d.settled === false) states = ["done", "done", "done", "now"];
    else if (s === "FAILED") states = ["done", "fail", "", ""];
    else return null;
    const labels = s === "REDEPLOYING" ? ["Set up", "Rebuild", "Roll out", "Live"] : ["Set up", "Build", "Deploy", "Live"];
    return h("div", null,
      h("div", { class: "track", role: "img", "aria-label": "Progress: " + statusLabel(d) }, states.map((c) => h("span", { class: c }))),
      h("div", { class: "track-labels", "aria-hidden": "true" }, labels.map((l, i) => h("span", { class: states[i] ? "on" : "", text: l }))));
  }
  function stageText(d) {
    if (d.status === "FAILED") return buildFailed(d) ? "The build failed. Open it to see the build log." : "Something went wrong. Open it to see the logs.";
    if (d.status === "CONFIGURED") return "Settings saved. Deploy when you're ready.";
    if (category(d) !== "busy") return "";
    const s = d.stage || STAGE_DEFAULT[d.status] || "";
    return s ? s.charAt(0).toUpperCase() + s.slice(1) + "…" : "";
  }
  function expiryBlock(d) {
    if (d.permanent) return h("div", { class: "expiry" }, h("div", { class: "expiry-row" }, h("span", null, "Permanent"), h("span", { text: "Never expires" })));
    const n = daysLeft(d.expiresAt);
    if (n === null) return null;
    const pct = Math.max(2, Math.min(100, (n / TTL_DAYS) * 100));
    return h("div", { class: "expiry" },
      h("div", { class: "expiry-row" }, h("span", null, "Expires ", h("b", { text: fmtDate(d.expiresAt) })), h("span", { text: n > 1 ? n + " days left" : n === 1 ? "1 day left" : "today" })),
      h("div", { class: "meter" + (n <= 3 ? " crit" : n <= 7 ? " warn" : "") }, h("i", { style: { width: pct + "%" } })));
  }

  function demoCard(d) {
    const cat = category(d);
    const url = safeHttps(d.url);
    const me = myEmail();
    const sub = [];
    if (d.client) sub.push(h("span", { class: "tag client", text: d.client }));
    if (d.permanent) sub.push(h("span", { class: "tag permanent", title: "Pinned by an admin: never expires, can't be destroyed", text: "Permanent" }));
    if (d.owner) sub.push(h("span", { text: d.owner.toLowerCase() === me ? "You" : d.owner }));

    const kebab = h("button", { class: "iconbtn", type: "button", "aria-label": "More actions for " + d.name, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("i-more"));
    kebab.addEventListener("click", (e) => { e.stopPropagation(); openMenu(kebab, demoMenu(d)); });

    let primary = null;
    if (d.status === "RUNNING" && url) primary = btn("Open", { cls: "btn-sm", icon: "i-external", href: url, external: true });
    else if ((d.status === "CONFIGURED" || d.status === "FAILED") && canDeploy(d)) {
      primary = btn(d.status === "FAILED" ? "Retry deploy" : "Deploy", { cls: "btn-sm btn-primary", icon: "i-rocket" });
      primary.addEventListener("click", (e) => { e.stopPropagation(); runAction("create", d.name, primary); });
    }
    // A failed build never started the app, so its card links to the build log instead of the (empty) app logs.
    const logs = buildFailed(d)
      ? btn("Build log", { cls: "btn-sm btn-ghost", icon: "i-terminal", href: "#/demo/" + encodeURIComponent(d.name) + "?tab=build" })
      : btn("Logs", { cls: "btn-sm btn-ghost", icon: "i-terminal", href: "#/demo/" + encodeURIComponent(d.name) + "?tab=logs" });

    const stage = stageText(d);
    const card = h("article", { class: "card demo", tabindex: "0", "aria-label": d.name + ", " + statusLabel(d) },
      h("div", { class: "demo-top" },
        h("div", { class: "demo-mark " + (cat === "live" ? "" : cat), text: d.name.slice(0, 2) }),
        h("div", { class: "demo-id" }, h("div", { class: "demo-name", text: d.name }), sub.length ? h("div", { class: "demo-sub" }, sub) : null),
        h("span", { class: "pill " + cat, text: statusLabel(d) })),
      h("div", { class: "demo-url" }, icon("i-globe", "icon-s"),
        url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url.replace(/^https:\/\//, "") }) : h("span", { class: "none", text: "No address yet" }),
        url ? h("button", { class: "iconbtn", type: "button", "aria-label": "Copy link", title: "Copy link", onclick: (e) => { e.stopPropagation(); copy(url, "Link copied"); } }, icon("i-copy", "icon-s")) : null),
      d.notes ? h("div", { class: "demo-notes", title: d.notes, text: d.notes }) : null,
      lifecycleTrack(d),
      stage ? h("div", { class: "stage-line" }, cat === "busy" ? icon("i-refresh", "icon-s spin") : icon(cat === "fail" ? "i-alert" : "i-info", "icon-s"), h("span", { text: stage })) : null,
      d.status === "RUNNING" ? expiryBlock(d) : null,
      h("div", { class: "demo-foot" }, primary, logs, h("div", { class: "demo-kebab" }, kebab)));
    const open = () => { S.lastFocus = card; go("demo/" + encodeURIComponent(d.name)); };
    card.addEventListener("click", (e) => { if (!e.target.closest("a,button,.menu")) open(); });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) open(); });
    return card;
  }

  function demoMenu(d) {
    const s = d.status, n = encodeURIComponent(d.name);
    return [
      { icon: "i-info", label: "View details", run: () => go("demo/" + n) },
      { icon: "i-terminal", label: "App logs", run: () => go("demo/" + n + "?tab=logs") },
      { icon: "i-terminal", label: "Build log", run: () => go("demo/" + n + "?tab=build") },
      (s === "CONFIGURED" || s === "FAILED") && canDeploy(d) ? { icon: "i-rocket", label: "Deploy", run: () => runAction("create", d.name) } : null,
      s === "RUNNING" && canDeploy(d) ? { icon: "i-redo", label: "Redeploy latest commit", run: () => runAction("redeploy", d.name) } : null,
      s === "RUNNING" && !d.permanent ? { icon: "i-calendar", label: "Extend 30 days", run: () => runAction("extend", d.name) } : null,
      s !== "DESTROYING" && isMine(d) ? { icon: "i-edit", label: "Edit settings", run: () => go("edit/" + n) } : null,
      s === "RUNNING" && isAdmin() ? { icon: "i-pin", label: d.permanent ? "Unpin (back to 30 days)" : "Make permanent", run: () => runAction(d.permanent ? "unpin" : "pin", d.name) } : null,
      d.permanent ? null : "-",
      d.permanent ? null : { icon: "i-trash", label: "Destroy", danger: true, run: () => runAction("destroy", d.name) },
    ];
  }

  // ---------------------------------------------------------------------------------------------
  // Drawer
  // ---------------------------------------------------------------------------------------------
  function openDrawer(name, tab) {
    if (!NAME_RE.test(name)) { go("demos"); return; }
    if (S.drawer && S.drawer.name === name) {
      if (S.drawer.tab !== tab) { S.drawer.tab = tab; refreshDrawerHead(); renderDrawerBody(); }
      return;
    }
    if (S.drawer) closeDrawer(true);
    track(name);
    if (!S.lastFocus) S.lastFocus = document.activeElement;
    const root = clear($("#drawer-root"));
    root.append(
      h("div", { class: "scrim", onclick: () => go("demos") }),
      h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "drawer-title" },
        h("div", { class: "drawer-head", id: "drawer-head" }),
        h("div", { class: "drawer-body", id: "drawer-body" })));
    document.body.style.overflow = "hidden";
    S.drawer = { name, tab, r: null, timer: null, logTimer: null, logLines: 100, tail: false, logs: [], all: [], mark: null, clearedAt: null };
    refreshDrawerHead();
    renderDrawerBody();
    const c = $("#drawer-close");
    if (c) c.focus();
    loadDrawer();
    S.drawer.timer = setInterval(() => {
      if (!S.drawer || document.hidden) return;
      const d = S.demos.get(S.drawer.name);
      if (!d || needsWatch(d)) loadDrawer();
    }, 10000);
  }
  function closeDrawer(silent) {
    if (!S.drawer) return;
    clearInterval(S.drawer.timer);
    clearInterval(S.drawer.logTimer);
    S.drawer = null;
    const root = $("#drawer-root");
    if (root) clear(root);
    document.body.style.overflow = "";
    if (!silent) go("demos");
    if (S.lastFocus && document.contains(S.lastFocus)) S.lastFocus.focus();
    S.lastFocus = null;
  }
  async function loadDrawer() {
    const D = S.drawer;
    if (!D) return;
    const r = await refreshOne(D.name);
    if (S.drawer !== D) return;
    D.r = r;
    updateDemos();
    refreshDrawerHead();
    // Re-render everything except a log view that's already up (that would reset its scroll and tail).
    if (!isLogTab(D.tab) || !$("#term")) renderDrawerBody();
  }
  function setTab(tab) {
    const D = S.drawer;
    if (!D) return;
    // App logs and the build log share one terminal; switching starts the new one clean.
    if (D.tab !== tab) Object.assign(D, { logs: [], all: [], mark: null, clearedAt: null, empty: null, build: null });
    D.tab = tab;
    history.replaceState(null, "", "#/demo/" + encodeURIComponent(D.name) + (tab === "overview" ? "" : "?tab=" + tab));
    refreshDrawerHead();
    renderDrawerBody();
  }

  function refreshDrawerHead() {
    const D = S.drawer;
    const head = $("#drawer-head");
    if (!D || !head) return;
    const d = S.demos.get(D.name) || { name: D.name, status: "UNKNOWN" };
    const missing = D.r && (D.r.code === 404 || D.r.code === 403);
    const cat = category(d);
    const url = safeHttps(d.url);
    clear(head);
    head.append(h("div", { class: "drawer-title" },
      h("div", { class: "demo-mark " + (cat === "live" ? "" : cat), text: D.name.slice(0, 2) }),
      h("h2", { id: "drawer-title", text: D.name }),
      missing ? null : h("span", { class: "pill " + cat, text: D.r ? statusLabel(d) : "Loading" }),
      h("button", { class: "btn btn-ghost btn-icon close", type: "button", id: "drawer-close", "aria-label": "Close", onclick: () => go("demos") }, icon("i-x"))));
    if (url) head.append(h("div", { class: "drawer-url" }, icon("i-globe", "icon-s"),
      h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: url.replace(/^https:\/\//, "") }),
      h("button", { class: "iconbtn", type: "button", "aria-label": "Copy link", onclick: () => copy(url, "Link copied") }, icon("i-copy", "icon-s"))));

    const acts = h("div", { class: "drawer-actions" });
    if (!missing && D.r) {
      const s = d.status;
      if (s === "RUNNING" && url) acts.append(btn("Open demo", { cls: "btn-primary", icon: "i-external", href: url, external: true }));
      const mine = isMine(d), deployer = canDeploy(d);
      if ((s === "CONFIGURED" || s === "FAILED") && deployer) { const b = btn(s === "FAILED" ? "Retry deploy" : "Deploy", { cls: "btn-primary", icon: "i-rocket" }); b.addEventListener("click", () => runAction("create", D.name, b)); acts.append(b); }
      const stuck = isStuck(Object.assign({}, D.r.data, { status: s }));
      if ((s === "RUNNING" || stuck) && deployer) { const b = btn("Redeploy", { icon: "i-redo" }); b.addEventListener("click", () => runAction("redeploy", D.name, b)); acts.append(b); }
      if (s === "RUNNING" && !d.permanent) { const b = btn("Extend 30 days", { icon: "i-calendar" }); b.addEventListener("click", () => runAction("extend", D.name, b)); acts.append(b); }
      if (s === "RUNNING" && isAdmin()) { const b = btn(d.permanent ? "Unpin" : "Make permanent", { icon: "i-pin" }); b.addEventListener("click", () => runAction(d.permanent ? "unpin" : "pin", D.name, b)); acts.append(b); }
      if (s !== "DESTROYING" && mine) acts.append(btn("Edit settings", { icon: "i-edit", href: "#/edit/" + encodeURIComponent(D.name) }));
      const rb = btn("", { cls: "btn-ghost btn-icon", icon: "i-refresh", aria: "Refresh", title: "Refresh" });
      rb.addEventListener("click", async () => { rb.querySelector("svg").classList.add("spin"); await loadDrawer(); if (S.drawer && isLogTab(S.drawer.tab)) loadLogs(); });
      acts.append(rb);
    }
    head.append(acts);
    if (!missing) {
      head.append(h("div", { class: "tabs", role: "tablist" }, [["overview", "Overview"], ["logs", "App logs"], ["build", "Build log"], ["settings", "Settings"]].map(([id, label]) =>
        h("button", { type: "button", role: "tab", "aria-selected": D.tab === id ? "true" : "false", text: label, onclick: () => setTab(id) }))));
    }
  }

  function renderDrawerBody() {
    const D = S.drawer;
    const body = $("#drawer-body");
    if (!D || !body) return;
    clear(body);
    clearInterval(D.logTimer);
    D.logTimer = null;
    if (!D.r) { body.append(h("div", { class: "bone l3" }), h("div", { class: "bone l3" }), h("div", { class: "bone l3" })); return; }
    if (D.r.code === 404 || D.r.code === 403) {
      body.append(h("div", { class: "empty" }, h("div", { class: "empty-art" }, logoMark()),
        h("h2", { text: D.r.code === 404 ? "No demo called " + D.name : "Not yours to see" }),
        h("p", { text: D.r.code === 404 ? "It may have been destroyed, or the name is mistyped. You can set it up as a new demo." : D.r.message || "Only the creator or an admin can open this demo." }),
        D.r.code === 404 ? btn("Set up " + D.name, { cls: "btn-primary", icon: "i-plus", href: "#/new?name=" + encodeURIComponent(D.name) }) : null));
      return;
    }
    if (!D.r.ok) { body.append(h("div", { class: "alert alert-err" }, icon("i-alert"), h("div", { class: "alert-body", text: errText(D.r) }))); return; }
    if (isLogTab(D.tab)) renderLogsTab(body);
    else if (D.tab === "settings") renderSettingsTab(body);
    else renderOverviewTab(body);
  }

  function kv(rows) {
    const dl = h("dl", { class: "kv" });
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === "") continue;
      dl.append(h("dt", { text: k }), h("dd", null, v));
    }
    return dl;
  }

  function renderOverviewTab(body) {
    const D = S.drawer;
    const d = D.r.data || {};
    const row = S.demos.get(D.name) || rowFromStatus(d);
    const cat = category(row);
    if (d.status === "FAILED") {
      body.append(h("div", { class: "alert alert-err" }, icon("i-alert"), h("div", { class: "alert-body" },
        h("strong", { text: "The last deployment failed" }), "Check the logs and the status report below, fix the repo or settings, then deploy again.",
        typeof d.lastFailure === "string" && d.lastFailure ? h("div", { class: "mt-8", text: "Cause: " + d.lastFailure }) : null,
        typeof d.lastFailure === "string" && /health check/i.test(d.lastFailure)
          ? h("div", { class: "mt-8", text: "Check that the port matches the container and the health path returns 200-399 without a login." }) : null)));
    } else if (isStuck(d)) {
      body.append(h("div", { class: "alert alert-warn", role: "alert" }, icon("i-alert"), h("div", { class: "alert-body" },
        h("strong", { text: "This deployment looks stuck" }), "It has not changed for over " + STUCK_MINUTES + " minutes. Redeploy or destroy frees it.")));
    } else if (cat === "busy") {
      body.append(h("div", { class: "alert alert-info" }, icon("i-refresh", "spin"), h("div", { class: "alert-body" },
        h("strong", { text: stageText(row) || "Working…" }), "This panel updates every 10 seconds. Builds usually take 5–10 minutes; you'll get an email when it's done.")));
    } else if (d.status === "CONFIGURED") {
      const verdict = typeof d.lastMessage === "string" && /^Setup saved for /.test(d.lastMessage) ? cleanVerdict(d.lastMessage) : "";
      body.append(h("div", { class: "alert alert-info" }, icon("i-info"), h("div", { class: "alert-body" },
        h("strong", { text: "Ready to deploy" }), verdict || "Settings are saved. Press Deploy to build and launch it.")));
    }
    const svc = d.service || null;
    let health = null;
    if (svc && svc.desired !== undefined) {
      const dots = h("span", { class: "tasks", "aria-hidden": "true" });
      const total = Math.max(svc.desired || 0, (svc.running || 0) + (svc.pending || 0));
      for (let i = 0; i < total; i++) dots.append(h("i", { class: "task-dot " + (i < svc.running ? "run" : i < svc.running + svc.pending ? "pend" : "") }));
      health = h("span", null, dots, svc.running + " of " + svc.desired + " running" + (svc.pending ? ", " + svc.pending + " starting" : "") + (d.settled ? " · healthy" : ""));
    }
    const n = daysLeft(d.expiresAt);
    body.append(h("div", { class: "mt-16" }, kv([
      ["Status", h("span", { class: "pill " + cat, text: statusLabel(row) })],
      ["Stage", d.stage ? d.stage.charAt(0).toUpperCase() + d.stage.slice(1) : ""],
      ["Health", health],
      ["Expires", d.permanent ? "Never (permanent)" : d.expiresAt ? fmtDate(d.expiresAt) + " · " + (n > 0 ? "in " + n + (n === 1 ? " day" : " days") : "today") + (d.extensions ? " · extended " + d.extensions + "×" : "") : ""],
      ["Owner", d.ownerEmail],
      ["Client", d.client],
      ["Commit", d.commitSha ? h("code", { text: d.commitSha.slice(0, 12) }) : ""],
      ["Created", d.createdAt ? fmtDateTime(d.createdAt) : ""],
      ["First live", d.firstLiveAt ? fmtDateTime(d.firstLiveAt) : ""],
      ["Last deploy", d.deployedAt ? fmtDateTime(d.deployedAt) + " (" + fmtRel(d.deployedAt) + ")" : ""],
    ])));
    if (d.notes) body.append(h("h3", { class: "sub-h", text: "Notes" }), h("div", { class: "notes-full", text: d.notes }));
    if (D.r.message) body.append(h("h3", { class: "sub-h", text: "Status report" }), h("pre", { class: "msg-pre", text: D.r.message.replace(/\*/g, "") }));
  }
  function cleanVerdict(m) {
    return m.replace(/^Setup saved for \S+ \([^)]*\)\.\s*/, "").replace(/\s*Run create \S+\.$/, "").replace(/\s*Fix that and run setup again, or run create anyway\.?$/, "");
  }

  function renderSettingsTab(body) {
    const D = S.drawer;
    const d = D.r.data || {};
    const repo = safeHttps(d.repoUrl);
    const size = SIZES.find((s) => s.id === d.size);
    const env = Array.isArray(d.env) ? d.env : [];
    const destroy = btn("Destroy " + D.name, { cls: "btn-danger", icon: "i-trash" });
    destroy.addEventListener("click", () => runAction("destroy", D.name, destroy));
    add(body, [
      kv([
        ["Repository", repo ? h("a", { href: repo, target: "_blank", rel: "noopener noreferrer", text: repo.replace(/^https:\/\/github\.com\//, "") }) : d.repoUrl],
        ["Branch", d.branch ? h("code", { text: d.branch }) : ""],
        ["Port", d.port ? String(d.port) : ""],
        ["Health path", d.healthPath ? h("code", { text: d.healthPath }) : ""],
        ["Size", d.size ? d.size + (size ? " · " + size.spec : "") : ""],
        ["Client", d.client || "None"],
        ["Env variables", env.length ? h("span", { class: "row" }, env.map((k) => h("span", { class: "tag", text: k }))) : "None"],
      ]),
      isMine({ owner: d.ownerEmail })
        ? h("div", { class: "row mt-16" }, btn("Edit settings", { cls: "btn-primary", icon: "i-edit", href: "#/edit/" + encodeURIComponent(D.name) }),
          h("span", { class: "hint", text: "Saving replaces the whole config. Redeploy afterwards to apply it." }))
        : h("p", { class: "hint mt-16", text: "Only " + d.ownerEmail + (isAdmin() ? " can change these settings." : " can change these settings or redeploy.") }),
      d.permanent
        ? h("p", { class: "hint mt-16", text: "This demo is permanent, so it can't be destroyed. An admin has to unpin it first." })
        : h("div", { class: "danger-zone" }, h("h3", { text: "Danger zone" }),
          h("p", { text: "Destroying deletes the service and images for good. The name becomes free for anyone." }), destroy),
    ]);
  }

  // Two log views share the terminal: the running app's logs and the latest build's log (ADR 022).
  function logAction(tab) { return tab === "build" ? "build-logs" : "logs"; }
  function isLogTab(tab) { return tab === "logs" || tab === "build"; }
  // FAILED without an image: the build failed, so no container ever ran.
  function buildFailed(d) { return d.status === "FAILED" && !d.imageUri; }

  function renderLogsTab(body) {
    const D = S.drawer;
    const lines = h("select", { class: "select select-sm", "aria-label": "Lines" }, [50, 100, 200, 500].map((n) => h("option", { value: String(n), text: n + " lines", selected: n === D.logLines })));
    lines.addEventListener("change", () => { D.logLines = parseInt(lines.value, 10); loadLogs(); });
    const tail = h("input", { type: "checkbox", checked: D.tail });
    tail.addEventListener("change", () => { D.tail = tail.checked; setTail(); });
    add(body, [
      h("div", { class: "term-bar" }, lines,
        h("label", { class: "switch" }, tail, "Live tail"),
        h("span", { class: "grow" }),
        btn("Clear", { cls: "btn-sm btn-ghost", icon: "i-x", onclick: clearLogs }),
        btn("Copy", { cls: "btn-sm btn-ghost", icon: "i-copy", onclick: () => copy((D.logs || []).join("\n"), "Logs copied") }),
        btn("Download", { cls: "btn-sm btn-ghost", icon: "i-download", onclick: downloadLogs }),
        btn("Reload", { cls: "btn-sm", icon: "i-refresh", onclick: () => loadLogs() })),
      D.tab === "build" ? h("p", { class: "hint", id: "build-meta" }) : null,
      h("div", { class: "term", id: "term", tabindex: "0", "aria-label": D.tab === "build" ? "Build log" : "Container logs" }, h("span", { class: "dim", text: "Loading logs…" })),
    ]);
    loadLogs();
    setTail();
  }
  function setTail() {
    const D = S.drawer;
    if (!D) return;
    clearInterval(D.logTimer);
    D.logTimer = D.tail ? setInterval(() => { if (!document.hidden) loadLogs(true); }, 5000) : null;
  }
  async function loadLogs(quiet) {
    const D = S.drawer;
    if (!D || !isLogTab(D.tab)) return;
    const tab = D.tab;
    const r = await api({ action: logAction(tab), name: D.name, args: { lines: String(D.logLines) } });
    const term = $("#term");
    if (S.drawer !== D || D.tab !== tab || !term) return;
    if (!r.ok) { clear(term); term.append(h("span", { class: "err", text: errText(r) })); return; }
    D.all = r.data && Array.isArray(r.data.lines) ? r.data.lines : [];
    D.build = r.data && r.data.build ? r.data.build : null;
    D.empty = r.message || null;
    renderBuildMeta();
    renderLogLines(quiet);
  }
  function renderBuildMeta() {
    const D = S.drawer;
    const el = $("#build-meta");
    if (!D || !el) return;
    const b = D.build;
    if (!b) { el.textContent = ""; return; }
    const st = String(b.status || "unknown").toLowerCase().replace(/_/g, " ");
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
    el.textContent = "Build " + st + (b.status === "IN_PROGRESS" && b.phase ? " (" + String(b.phase).toLowerCase() + ")" : "")
      + (b.started ? " · started " + when(b.started) : "") + (b.ended ? " · ended " + when(b.ended) : "")
      + ". Logs are kept 7 days.";
  }
  // The platform only returns the last N lines, so Clear can't drop anything server side. It keeps the last
  // few lines on screen as a marker and from then on shows only what follows the marker's last occurrence.
  // If the marker has scrolled out of the returned window, every line is new.
  const MARK_LEN = 5;
  function afterMark(arr, mark) {
    if (!mark) return arr;
    for (let end = arr.length; end >= mark.length; end--) {
      let hit = true;
      for (let k = 0; k < mark.length && hit; k++) hit = arr[end - mark.length + k] === mark[k];
      if (hit) return arr.slice(end);
    }
    return arr;
  }
  function clearLogs() {
    const D = S.drawer;
    if (!D) return;
    D.mark = D.all.length ? D.all.slice(-MARK_LEN) : null;
    D.clearedAt = new Date();
    renderLogLines();
  }
  function showAllLogs() {
    const D = S.drawer;
    if (!D) return;
    D.mark = null;
    D.clearedAt = null;
    renderLogLines();
  }
  function renderLogLines(quiet) {
    const D = S.drawer;
    const term = $("#term");
    if (!D || !term) return;
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    clear(term);
    const arr = afterMark(D.all, D.mark);
    D.logs = arr;
    if (D.clearedAt) {
      const all = h("button", { type: "button", class: "term-link", text: "Show all" });
      all.addEventListener("click", showAllLogs);
      term.append(h("span", { class: "ln dim" }, "── Cleared at " + D.clearedAt.toLocaleTimeString() + ". Older lines hidden. ", all));
    }
    if (!arr.length) {
      const d = S.demos.get(D.name);
      const none = D.tab === "build" ? D.empty || "No build output yet."
        : d && buildFailed(d) ? "The build failed, so the app never started. See the Build log tab."
        : "No logs yet. They appear once the container starts.";
      const msg = !D.clearedAt ? none
        : D.tail ? "Waiting for new lines…" : "No new lines yet. Turn on Live tail or Reload.";
      term.append(h("span", { class: "dim", text: msg }));
      return;
    }
    for (const l of arr) {
      const cls = /\b(error|exception|fatal|traceback|panic|failed)\b/i.test(l) ? "ln err" : /\bwarn(ing)?\b/i.test(l) ? "ln wrn" : "ln";
      term.append(h("span", { class: cls, text: l }));
    }
    if (!quiet || atBottom) term.scrollTop = term.scrollHeight;
  }
  function downloadLogs() {
    const D = S.drawer;
    if (!D || !D.logs || !D.logs.length) { toast("No logs to download yet.", "info", 2000); return; }
    const blob = new Blob([D.logs.join("\n") + "\n"], { type: "text/plain" });
    const a = h("a", { href: URL.createObjectURL(blob), download: D.name + (D.tab === "build" ? "-build-logs.txt" : "-logs.txt") });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------------------------------------
  // Wizard (new demo / edit settings)
  // ---------------------------------------------------------------------------------------------
  const WSTEPS = [
    { t: "Name & address", d: "Where the demo lives" },
    { t: "Source", d: "GitHub repo and access" },
    { t: "Runtime", d: "Port, health check, size" },
    { t: "Environment", d: "Variables for your app" },
    { t: "Review", d: "Save and deploy" },
  ];

  function renderWizard(main, editName) {
    const r = route();
    const pre = (r.q.get("name") || "").toLowerCase();
    S.wiz = {
      mode: editName ? "edit" : "new",
      step: 0, max: editName ? WSTEPS.length - 1 : 0,
      data: { name: editName || (NAME_RE.test(pre) ? pre : ""), client: "", repo: "", branch: "main", pat: "", port: "", health: "", size: "tiny", env: [{ k: "", v: "" }], notes: "" },
      envNames: [], origStatus: "", origAuth: "", origNotes: "", keyFile: "", errors: {}, progress: null, loading: !!editName, loadError: "",
    };
    add(main, [
      h("a", { class: "back", href: editName ? "#/demo/" + encodeURIComponent(editName) + "?tab=settings" : "#/demos" }, icon("i-left", "icon-s"), editName ? "Back to " + editName : "Back to demos"),
      h("div", { class: "page-head" }, h("div", { class: "grow" },
        h("h1", { text: editName ? "Edit " + editName : "New demo" }),
        h("p", { class: "sub", text: editName ? "Change how this demo is built and run. Saving replaces the whole config; redeploy to apply it." : "Five quick steps. Nothing is deployed until you say so." }))),
      h("div", { class: "wizard" }, h("ol", { class: "steps", id: "wiz-steps" }), h("section", { class: "card wiz-panel", id: "wiz-panel" })),
    ]);
    // Enter in a text field moves to the next step (env rows excepted: Enter there would be surprising).
    $("#wiz-panel").addEventListener("keydown", (e) => {
      const W = S.wiz;
      if (e.key !== "Enter" || !W || W.progress || W.step >= 4 || e.target.tagName !== "INPUT" || e.target.closest(".env-row")) return;
      e.preventDefault();
      nextStep();
    });
    if (editName) loadEdit(editName); else renderWiz();
  }

  async function loadEdit(name) {
    renderWiz();
    const W = S.wiz;
    const r = await api({ action: "status", name });
    if (S.wiz !== W) return;
    W.loading = false;
    if (!r.ok || !r.data) { W.loadError = errText(r); renderWiz(); return; }
    const d = r.data;
    W.origStatus = d.status;
    W.origAuth = d.githubAuth || "";
    Object.assign(W.data, {
      client: d.client || "", repo: d.repoUrl || "", branch: d.branch || "main", port: d.port ? String(d.port) : "",
      health: d.healthPath || "", size: d.size || "tiny", notes: typeof d.notes === "string" ? d.notes : "",
    });
    W.origNotes = W.data.notes;
    W.envNames = Array.isArray(d.env) ? d.env : [];
    W.data.env = W.envNames.length ? W.envNames.map((k) => ({ k, v: "" })) : [{ k: "", v: "" }];
    renderWiz();
  }

  function renderWiz() {
    const W = S.wiz;
    const steps = $("#wiz-steps");
    if (!steps) return;
    clear(steps);
    WSTEPS.forEach((s, i) => {
      const cls = W.progress ? "done" : i === W.step ? "now" : i <= W.max ? "done" : "";
      const b = h("button", {
        type: "button", disabled: !!W.progress || i > W.max || W.loading, "aria-current": i === W.step ? "step" : null,
        onclick: () => { collect(); if (i < W.step || validateStep(W.step)) { W.step = i; } renderWiz(); },
      }, h("span", { class: "step-n" }, cls === "done" && i !== W.step ? icon("i-check", "icon-s") : String(i + 1)),
        h("span", null, h("span", { class: "step-t", text: s.t }), h("span", { class: "step-d", text: s.d })));
      steps.append(h("li", { class: cls }, b));
    });
    const panel = clear($("#wiz-panel"));
    if (W.loading) { panel.append(h("div", { class: "bone l1" }), h("div", { class: "bone l3" }), h("div", { class: "bone l3" })); return; }
    if (W.loadError) { panel.append(h("div", { class: "alert alert-err" }, icon("i-alert"), h("div", { class: "alert-body", text: W.loadError }))); return; }
    if (W.progress) { renderProgress(panel); return; }
    [wizName, wizSource, wizRuntime, wizEnv, wizReview][W.step](panel);
    if (W.step < 4) {
      const next = btn("Continue", { cls: "btn-primary btn-lg" });
      next.append(icon("i-right"));
      next.addEventListener("click", nextStep);
      panel.append(h("div", { class: "wiz-foot" },
        W.step > 0 ? btn("Back", { cls: "btn-ghost", icon: "i-left", onclick: () => { collect(); W.step--; renderWiz(); } }) : null,
        h("span", { class: "grow" }), next));
    }
    const bad = panel.querySelector("[aria-invalid='true']");
    const first = bad || panel.querySelector("input:not([disabled]):not([type=radio])");
    if (first) first.focus({ preventScroll: true });
  }
  function nextStep() {
    const W = S.wiz;
    collect();
    if (!validateStep(W.step)) { renderWiz(); return; }
    W.step++;
    W.max = Math.max(W.max, W.step);
    renderWiz();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function field(id, label, input, opts) {
    opts = opts || {};
    const err = S.wiz.errors[id];
    if (err) input.setAttribute("aria-invalid", "true");
    if (opts.hint) input.setAttribute("aria-describedby", id + "-hint");
    return h("div", { class: "field" + (opts.span ? " span-2" : "") },
      h("label", { for: id }, label, opts.opt ? h("span", { class: "opt", text: "optional" }) : null),
      opts.wrap ? opts.wrap(input) : input,
      err ? h("span", { class: "err-text", text: err }) : null,
      opts.hint ? h("span", { class: "hint", id: id + "-hint" }, opts.hint) : null);
  }
  function inp(id, value, attrs) {
    const el = h("input", Object.assign({ class: "input", id, value: value || "", autocomplete: "off", spellcheck: "false", "data-k": id }, attrs || {}));
    el.addEventListener("input", () => { el.removeAttribute("aria-invalid"); });
    return el;
  }
  function collect() {
    const W = S.wiz;
    const panel = $("#wiz-panel");
    if (!W || !panel) return;
    panel.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.getAttribute("data-k");
      if (Object.prototype.hasOwnProperty.call(W.data, k) && typeof W.data[k] === "string") W.data[k] = el.value.trim();
    });
    const rows = panel.querySelectorAll(".env-row");
    if (rows.length) W.data.env = Array.from(rows).map((r) => ({ k: r.querySelector(".ek").value.trim(), v: r.querySelector(".ev").value }));
  }

  function validateStep(i) {
    const W = S.wiz, d = W.data, e = {};
    if (i === 0) {
      if (!NAME_RE.test(d.name)) e.name = "3–24 characters: lowercase letters, digits and hyphens. Start with a letter, end with a letter or digit.";
      else if (RESERVED.has(d.name)) e.name = "“" + d.name + "” is reserved. Pick another name.";
      if (d.client && !CLIENT_RE.test(d.client)) e.client = "1–20 characters: lowercase letters, digits and hyphens.";
      if (d.notes.length > MAX_NOTES) e.notes = "At most " + MAX_NOTES + " characters (now " + d.notes.length + ").";
    } else if (i === 1) {
      if (!REPO_RE.test(d.repo)) e.repo = "Use the repo's address: https://github.com/<org>/<repo>";
      if (d.branch && !BRANCH_RE.test(d.branch)) e.branch = "That isn't a valid branch name.";
      if (accessRequired() && !d.pat) {
        e.pat = W.mode === "new" ? "GitHub access is needed the first time, so Lilypad can read the repo."
          : "This demo was destroyed, so GitHub access is needed again.";
      } else if (/^(ssh-[a-z0-9]+|ecdsa-sha2-\S+|sk-\S+)\s+AAAA/.test(d.pat) || d.pat.includes("PUBLIC KEY-----")) {
        e.pat = "That's the public key. Use the private key (the file without .pub).";
      }
    } else if (i === 2) {
      if (d.port && !(/^\d+$/.test(d.port) && +d.port >= 1 && +d.port <= 65535)) e.port = "A port between 1 and 65535.";
      if (d.health && !/^\/\S*$/.test(d.health)) e.health = "A path starting with /, for example /health.";
    } else if (i === 3) {
      const seen = new Set();
      d.env.forEach((row, n) => {
        if (!row.k && !row.v) return;
        if (!ENV_KEY_RE.test(row.k)) e["env" + n] = "Use UPPER_SNAKE_CASE, like API_URL.";
        else if (seen.has(row.k)) e["env" + n] = row.k + " is listed twice.";
        seen.add(row.k);
      });
    }
    W.errors = e;
    return Object.keys(e).length === 0;
  }

  function addressParts() {
    const d = S.wiz.data;
    return { label: (d.name || "your-demo") + (d.client ? "-" + d.client : ""), dom: demoDomain() || "<demo domain>" };
  }
  function urlPreview(eyebrow) {
    const u = h("div", { class: "u" });
    const paint = () => { const p = addressParts(); clear(u).append("https://", h("b", { text: p.label }), "." + p.dom); };
    paint();
    return { el: h("div", { class: "url-preview" }, h("div", { class: "eyebrow", text: eyebrow }), u), paint };
  }

  function wizName(panel) {
    const W = S.wiz, d = W.data;
    const name = inp("name", d.name, { placeholder: "acme-poc", disabled: W.mode === "edit", maxlength: "24" });
    const client = inp("client", d.client, { placeholder: "acme", maxlength: "20" });
    const prev = urlPreview("Your demo will be at");
    name.addEventListener("input", () => { name.value = name.value.toLowerCase(); d.name = name.value.trim(); prev.paint(); });
    client.addEventListener("input", () => { client.value = client.value.toLowerCase(); d.client = client.value.trim(); prev.paint(); });
    const notes = h("textarea", { class: "textarea notes-input", id: "notes", "data-k": "notes", value: d.notes, maxlength: String(MAX_NOTES), rows: "3",
      placeholder: "Acme pilot. Demo on 30 Oct.\nLog in with the guest button." });
    const counter = h("span", { class: "char-count", "aria-live": "polite" });
    const count = () => { counter.textContent = notes.value.length + " / " + MAX_NOTES; counter.classList.toggle("near", notes.value.length > MAX_NOTES * 0.9); };
    count();
    notes.addEventListener("input", () => { notes.removeAttribute("aria-invalid"); count(); });
    add(panel, [
      h("h2", { text: "Name your demo" }),
      h("p", { class: "lead", text: "The name becomes the web address. Pick something short your client will recognise." }),
      h("div", { class: "form-grid" },
        field("name", "Demo name", name, { hint: W.mode === "edit" ? "The name can't change. Destroy and set up again to rename." : "3–24 characters: lowercase letters, digits, hyphens." }),
        field("client", "Client", client, { opt: true, hint: "Adds -client to the address and tags the demo. Fixed after the first deploy." }),
        field("notes", "Notes", notes, { opt: true, span: true, wrap: (el) => h("div", { class: "notes-wrap" }, el, counter),
          hint: "For your own record: who it is for, dates, demo tips. Shown to you and admins. Not for passwords." })),
      prev.el,
    ]);
  }

  // GitHub access is one field: a fine-grained PAT, a deploy key's private key, or the word "public".
  // The server works out which (and rebuilds a key whose newlines a password field dropped).
  const AUTH_LABEL = { public: "Public", "deploy-key": "Deploy key", pat: "Token" };
  function accessKind(v) {
    v = (v || "").trim();
    if (v.toLowerCase() === "public") return "public";
    return v.includes("PRIVATE KEY-----") ? "deploy-key" : "pat";
  }
  function accessRequired() {
    const W = S.wiz;
    return W.mode === "new" || W.origStatus === "DESTROYED";
  }

  function wizSource(panel) {
    const W = S.wiz, d = W.data;
    const keep = !accessRequired();
    const repo = inp("repo", d.repo, { placeholder: "https://github.com/your-org/your-repo", type: "url" });
    const branch = inp("branch", d.branch, { placeholder: "main" });
    const pat = inp("pat", d.pat, { type: "password", placeholder: keep ? "Leave blank to keep the saved one" : "public, github_pat_…, or a private key" });
    pat.addEventListener("input", () => { W.keyFile = ""; });
    const eye = h("button", { class: "btn btn-icon", type: "button", "aria-label": "Show value" }, icon("i-eye"));
    eye.addEventListener("click", () => { const s = pat.type === "password"; pat.type = s ? "text" : "password"; eye.setAttribute("aria-label", s ? "Hide value" : "Show value"); clear(eye).append(icon(s ? "i-eye-off" : "i-eye")); });
    // Load a deploy key's private key from a file. The text goes into the field only; it is never logged.
    const picker = h("input", { type: "file", hidden: true, "aria-hidden": "true", tabindex: "-1" });
    const loadKey = btn("Load key file", { cls: "btn-sm", icon: "i-file", aria: "Load a deploy key's private key from a file" });
    loadKey.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
      const f = picker.files && picker.files[0];
      picker.value = "";
      if (!f) return;
      const fail = (msg) => { collect(); W.keyFile = ""; W.errors = Object.assign({}, W.errors, { pat: msg }); renderWiz(); };
      if (f.size > 16384) { fail(f.name + " is too large to be a private key."); return; }
      const rd = new FileReader();
      rd.onerror = () => fail("Couldn't read " + f.name + ".");
      rd.onload = () => {
        const text = String(rd.result || "");
        if (!text.includes("PRIVATE KEY-----")) { fail(f.name + " is not a private key. Use the deploy key file without .pub."); return; }
        collect();
        d.pat = text.trim();
        W.keyFile = f.name;
        delete W.errors.pat;
        renderWiz();
      };
      rd.readAsText(f);
    });
    const saved = W.mode === "edit" && keep && W.origAuth ? " Saved now: " + (AUTH_LABEL[W.origAuth] || W.origAuth) + "." : "";
    add(panel, [
      h("h2", { text: "Where's the code?" }),
      h("p", { class: "lead", text: "Lilypad builds the Dockerfile at the root of this repo and branch." }),
      h("div", { class: "form-grid" },
        field("repo", "GitHub repository", repo, { span: true, hint: "The repo needs a Dockerfile at its root." }),
        field("branch", "Branch", branch, { hint: "Default: main" }),
        h("div"),
        field("pat", "GitHub access", pat, {
          span: true, opt: keep, wrap: (i) => h("div", null, h("div", { class: "input-group" }, i, eye),
            h("div", { class: "mt-8" }, loadKey, picker, W.keyFile && accessKind(d.pat) === "deploy-key" ? h("span", { class: "hint", text: " Loaded from " + W.keyFile + "." }) : null)),
          hint: h("span", null, "One of three; Lilypad works out which. ",
            h("b", { text: "Public repo:" }), " type ", h("code", { text: "public" }), ". ",
            h("b", { text: "Deploy key:" }), " the private key (no passphrase; ed25519 recommended) whose .pub is under the repo's Settings › Deploy keys, read-only. Paste it or load the file. ",
            h("b", { text: "Token:" }), " a fine-grained token with read-only ", h("b", { text: "Contents" }), " on this one repo (",
            h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener noreferrer", text: "create one on GitHub" }), ").",
            keep ? " Leave blank to keep the saved one." + saved : ""),
        })),
      h("div", { class: "alert alert-info mt-24" }, icon("i-lock"), h("div", { class: "alert-body", text: "A token or key is sent once and kept by the platform so it can rebuild on redeploy. This browser never stores it, and it's never shown back." })),
    ]);
  }

  function wizRuntime(panel) {
    const d = S.wiz.data;
    const port = inp("port", d.port, { type: "number", min: "1", max: "65535", placeholder: "8080", inputmode: "numeric" });
    const health = inp("health", d.health, { placeholder: "/" });
    const grid = h("div", { class: "choice-grid", role: "radiogroup", "aria-label": "Size" });
    for (const s of SIZES) {
      const locked = s.admin && !isAdmin();
      const radio = h("input", { type: "radio", name: "size", value: s.id, checked: d.size === s.id, disabled: locked });
      const lab = h("label", { class: "choice" + (d.size === s.id ? " on" : "") + (locked ? " disabled" : ""), title: locked ? "Only admins can pick large" : null }, radio,
        h("span", { class: "c-t" }, s.id, s.def ? h("span", { class: "tag", text: "default" }) : null, s.admin ? h("span", { class: "c-badge", text: "admin" }) : null),
        h("span", { class: "c-d", text: s.spec }), h("span", { class: "c-d", text: s.d }));
      radio.addEventListener("change", () => { d.size = s.id; grid.querySelectorAll(".choice").forEach((c) => c.classList.remove("on")); lab.classList.add("on"); });
      grid.append(lab);
    }
    add(panel, [
      h("h2", { text: "How does it run?" }),
      h("p", { class: "lead", text: "Tell Lilypad which port your container listens on and how to check it's healthy." }),
      h("div", { class: "form-grid" },
        field("port", "Container port", port, { hint: "The port your app listens on. Default: 8080" }),
        field("health", "Health check path", health, { hint: "Must answer 200–399 without a login. Default: /" })),
      h("div", { class: "field mt-24" }, h("span", { class: "label", text: "Size" }), grid),
    ]);
  }

  function wizEnv(panel) {
    const W = S.wiz;
    const rowsBox = h("div", { class: "env-rows" });
    const paint = () => {
      clear(rowsBox);
      W.data.env.forEach((row, n) => {
        const k = h("input", { class: "input ek", value: row.k, placeholder: "KEY", "aria-label": "Variable name " + (n + 1), autocomplete: "off", spellcheck: "false" });
        const v = h("input", { class: "input ev", value: row.v, placeholder: W.envNames.indexOf(row.k) >= 0 && !row.v ? "re-enter value" : "value", "aria-label": "Value " + (n + 1), autocomplete: "off", spellcheck: "false" });
        k.addEventListener("input", () => { const p = k.selectionStart; k.value = k.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"); k.setSelectionRange(p, p); k.removeAttribute("aria-invalid"); });
        if (W.errors["env" + n]) k.setAttribute("aria-invalid", "true");
        const del = h("button", { class: "btn btn-ghost btn-icon", type: "button", "aria-label": "Remove variable " + (n + 1),
          onclick: () => { collect(); W.data.env.splice(n, 1); if (!W.data.env.length) W.data.env.push({ k: "", v: "" }); W.errors = {}; paint(); } }, icon("i-trash"));
        rowsBox.append(h("div", { class: "env-row" }, k, v, del));
        if (W.errors["env" + n]) rowsBox.append(h("span", { class: "err-text", text: W.errors["env" + n] }));
      });
    };
    paint();
    const addRow = btn("Add variable", { cls: "btn-sm", icon: "i-plus", onclick: () => { collect(); W.data.env.push({ k: "", v: "" }); paint(); const ks = rowsBox.querySelectorAll(".ek"); ks[ks.length - 1].focus(); } });
    const pasteBox = h("textarea", { class: "textarea", placeholder: "API_URL=https://example.com\nFEATURE_FLAG=true", spellcheck: "false", "aria-label": "Paste .env contents" });
    const pasteWrap = h("div", { class: "stack mt-16", hidden: true }, pasteBox,
      h("div", { class: "row" }, btn("Add these", { cls: "btn-sm btn-primary", onclick: () => {
        collect();
        const parsed = parseEnv(pasteBox.value);
        if (!parsed.length) { toast("Nothing to add. Use KEY=VALUE, one per line.", "err", 3000); return; }
        const map = new Map(W.data.env.filter((r) => r.k || r.v).map((r) => [r.k, r.v]));
        for (const [k, v] of parsed) map.set(k, v);
        W.data.env = Array.from(map, ([k, v]) => ({ k, v }));
        pasteBox.value = ""; pasteWrap.hidden = true; paint();
        toast("Added " + parsed.length + " variable" + (parsed.length === 1 ? "" : "s"), "ok", 2000);
      } }), btn("Cancel", { cls: "btn-sm btn-ghost", onclick: () => { pasteWrap.hidden = true; } })));
    add(panel, [
      h("h2", { text: "Environment variables" }),
      h("p", { class: "lead", text: "Optional settings your app reads at runtime. Leave empty if it needs none." }),
      W.envNames.length ? h("div", { class: "alert alert-warn", style: { marginBottom: "16px" } }, icon("i-warn"), h("div", { class: "alert-body" },
        h("strong", { text: "Re-enter the values" }), "Lilypad never sends saved values back, only the names. Saving with an empty value sets it to empty.")) : null,
      h("div", { class: "env-head", "aria-hidden": "true" }, h("span", { text: "Name" }), h("span", { text: "Value" }), h("span")),
      rowsBox,
      h("div", { class: "row mt-16" }, addRow, btn("Paste .env", { cls: "btn-sm btn-ghost", icon: "i-file", onclick: () => { pasteWrap.hidden = false; pasteBox.focus(); } })),
      pasteWrap,
      h("div", { class: "alert alert-warn mt-24" }, icon("i-shield"), h("div", { class: "alert-body", text: "Platform admins can read these values." })),
    ]);
  }
  function parseEnv(text) {
    const out = [];
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim();
      if (!line || line[0] === "#") continue;
      line = line.replace(/^export\s+/, "");
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      if (ENV_KEY_RE.test(k)) out.push([k, v]);
    }
    return out;
  }

  function wizReview(panel) {
    const W = S.wiz, d = W.data;
    const env = d.env.filter((r) => r.k);
    const size = SIZES.find((s) => s.id === d.size);
    const section = (title, step, rows) => h("div", { class: "card" },
      h("h3", null, title, h("button", { class: "linklike", type: "button", text: "Edit", onclick: () => { W.step = step; renderWiz(); } })),
      h("dl", null, rows.map(([k, v]) => [h("dt", { text: k }), h("dd", null, v)])));
    const busyNow = W.mode === "edit" && W.origStatus && BUSY.has(W.origStatus);
    const deployLabel = W.mode === "edit" && W.origStatus === "RUNNING" ? "Save & redeploy" : "Save & deploy";
    const prev = urlPreview("Address");
    prev.el.style.marginTop = "0";
    prev.el.style.marginBottom = "16px";
    add(panel, [
      h("h2", { text: "Review" }),
      h("p", { class: "lead", text: "Check everything, then save. You can deploy now or later." }),
      prev.el,
      h("div", { class: "review" },
        section("Name & address", 0, [["Name", d.name], ["Client", d.client || "None"],
          ["Notes", d.notes ? h("span", { class: "notes-full", text: d.notes.length > 300 ? d.notes.slice(0, 299).trimEnd() + "\u2026" : d.notes })
            : W.mode === "edit" && W.origNotes ? "None (cleared)" : "None"]]),
        section("Source", 1, [["Repo", d.repo.replace(/^https:\/\/github\.com\//, "")], ["Branch", d.branch || "main"], ["Access", d.pat ? AUTH_LABEL[accessKind(d.pat)] + " (new)" : (!accessRequired() ? "Keep the saved one" + (W.origAuth ? " (" + (AUTH_LABEL[W.origAuth] || W.origAuth) + ")" : "") : "Missing")]]),
        section("Runtime", 2, [["Port", d.port || "8080"], ["Health", d.health || "/"], ["Size", (d.size || "tiny") + (size ? " · " + size.spec : "")]]),
        section("Environment", 3, [["Variables", env.length ? env.map((r) => r.k).join(", ") : "None"]])),
      busyNow ? h("div", { class: "alert alert-info mt-16" }, icon("i-info"), h("div", { class: "alert-body", text: "This demo is " + (STATUS_LABEL[W.origStatus] || W.origStatus).toLowerCase() + " right now. Save, then redeploy once it settles." })) : null,
      h("div", { class: "wiz-foot" },
        btn("Back", { cls: "btn-ghost", icon: "i-left", onclick: () => { W.step--; renderWiz(); } }),
        h("span", { class: "grow" }),
        btn("Save only", { cls: "btn-lg", onclick: () => submitWizard(false) }),
        busyNow ? null : btn(deployLabel, { cls: "btn-primary btn-lg", icon: "i-rocket", onclick: () => submitWizard(true) })),
    ]);
  }

  function setupArgs() {
    const d = S.wiz.data;
    const env = d.env.filter((r) => r.k).map((r) => r.k + "=" + r.v).join("\n");
    const args = { repoUrl: d.repo, client: d.client, branch: d.branch, port: d.port, healthPath: d.health, size: d.size, env, githubPat: d.pat };
    for (const k of Object.keys(args)) if (args[k] === "") delete args[k]; // like the CLI: blanks are left out
    // Notes are sent only when they change: a missing key keeps the stored notes, "" clears them.
    if (S.wiz.mode === "new" ? d.notes !== "" : d.notes !== S.wiz.origNotes) args.notes = d.notes;
    return args;
  }

  async function submitWizard(deploy) {
    const W = S.wiz;
    for (let i = 0; i < 4; i++) if (!validateStep(i)) { W.step = i; renderWiz(); toast("Fix the highlighted fields first.", "err", 3000); return; }
    const name = W.data.name;
    const action = W.mode === "edit" && W.origStatus === "RUNNING" ? "redeploy" : "create";
    const deployItem = () => ({ id: "deploy", t: action === "redeploy" ? "Starting the redeploy" : "Starting the deploy", st: "", d: "" });
    W.progress = {
      deploy, action, name, deployItem, done: false, waiting: false, failed: false,
      items: [
        { id: "save", t: "Saving settings", st: "run", d: "" },
        { id: "check", t: "Checking the repository", st: "", d: "Making sure Lilypad can read it and finds a Dockerfile." },
      ].concat(deploy ? [deployItem()] : []),
    };
    renderWiz();
    const set = (id, st, d) => { const it = W.progress.items.find((x) => x.id === id); if (it) { it.st = st; if (d !== undefined) it.d = d; } if (S.wiz === W) renderWiz(); };

    // A status call stores the status text as lastMessage, so an older setup verdict can't be mistaken for this one.
    await api({ action: "status", name });
    const r = await api({ action: "setup", name, args: setupArgs() });
    W.data.pat = ""; W.keyFile = "";
    if (!r.ok) { W.progress.failed = true; set("save", "err", errText(r)); return; }
    track(name);
    set("save", "ok", "Saved.");
    set("check", "run");
    const verdict = await waitForVerdict(name);
    if (S.wiz !== W) return;
    let checkOk = true;
    if (verdict === null) { checkOk = false; set("check", "warn", "The check is taking longer than usual. You can deploy anyway; the build fails if the repo or Dockerfile is wrong."); }
    else if (/Dockerfile found/i.test(verdict)) set("check", "ok", "Repo readable, Dockerfile found.");
    else { checkOk = false; set("check", "warn", cleanVerdict(verdict)); }
    if (!deploy) { W.progress.done = true; renderWiz(); refreshAll(); return; }
    if (!checkOk) { W.progress.waiting = true; renderWiz(); return; }
    await runDeployStep();
  }
  async function runDeployStep() {
    const W = S.wiz, P = W.progress;
    P.waiting = false;
    let it = P.items.find((x) => x.id === "deploy");
    if (!it) { it = P.deployItem(); P.items.push(it); }
    P.deploy = true; P.done = false;
    it.st = "run"; renderWiz();
    const r = await api({ action: P.action, name: P.name });
    if (S.wiz !== W) return;
    if (!r.ok) { it.st = "err"; it.d = errText(r); P.failed = true; renderWiz(); return; }
    it.st = "ok";
    it.d = P.action === "redeploy" ? "Building the latest commit. The current version keeps serving until the new one is healthy." : "Building now. Usually 5–10 minutes; you'll get an email when it's live.";
    P.done = true;
    renderWiz();
    refreshOne(P.name).then(updateDemos);
  }
  async function waitForVerdict(name) {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 2500));
      const r = await api({ action: "status", name });
      const m = r.data && r.data.lastMessage;
      if (typeof m === "string" && /^Setup saved for /.test(m)) return m;
    }
    return null;
  }

  function renderProgress(panel) {
    const W = S.wiz, P = W.progress;
    const ico = { run: ["run", "i-refresh", "spin"], ok: ["ok", "i-check"], warn: ["warn", "i-warn"], err: ["err", "i-x"], "": ["", "i-clock"] };
    const title = P.failed ? "Something went wrong" : P.done ? (P.deploy ? "On its way!" : "Settings saved") : P.waiting ? "Heads up" : "Working on it…";
    const lead = P.failed ? "Nothing was deployed. Fix the problem and try again."
      : P.done ? (P.deploy ? "Your demo is building. Follow along on its page." : "Deploy whenever you're ready.")
        : P.waiting ? "The repo check found a problem. Fix it first, or deploy anyway."
          : "Hang tight, this takes a few seconds.";
    add(panel, [
      h("h2", { text: title }),
      h("p", { class: "lead", text: lead }),
      h("ol", { class: "progress-list" }, P.items.map((it) => {
        const [c, i, extra] = ico[it.st] || ico[""];
        return h("li", null, h("span", { class: "p-ico " + c }, icon(i, extra)), h("div", null, h("div", { class: "p-t", text: it.t }), it.d ? h("div", { class: "p-d", text: it.d }) : null));
      })),
    ]);
    const foot = h("div", { class: "wiz-foot" });
    if (P.waiting) {
      foot.append(btn("Fix settings", { cls: "btn-ghost", icon: "i-edit", onclick: () => { W.progress = null; W.step = 1; renderWiz(); } }), h("span", { class: "grow" }),
        btn("Deploy anyway", { cls: "btn-primary btn-lg", icon: "i-rocket", onclick: runDeployStep }));
    } else if (P.failed) {
      foot.append(btn("Back to the form", { cls: "btn-primary", icon: "i-edit", onclick: () => { W.progress = null; W.step = 4; renderWiz(); } }));
    } else if (P.done) {
      foot.append(btn("Back to demos", { cls: "btn-ghost", href: "#/demos" }), h("span", { class: "grow" }),
        ...(P.deploy ? [] : [btn("Deploy now", { icon: "i-rocket", onclick: runDeployStep })]),
        btn("View demo", { cls: "btn-primary btn-lg", icon: "i-right", href: "#/demo/" + encodeURIComponent(P.name) }));
    }
    if (foot.childNodes.length) panel.append(foot);
  }

  // ---------------------------------------------------------------------------------------------
  // Help
  // ---------------------------------------------------------------------------------------------
  // Signing in. Shown on the public help page and in the onboarding guide.
  const ACCESS_STEPS = [
    ["Open Lilypad", "Most people land here already connected. If you're asked for a platform URL, paste the https:// address your Lilypad admin gave you."],
    ["Request a key", "Enter your exact @" + EMAIL_DOMAIN + " address. Lilypad emails you an access key; there's no password."],
    ["Paste the key", "Copy the key (it starts with lpk_) from the email “Your Lilypad access key” and paste it in. It works for 30 days in this browser."],
  ];
  const DEPLOY_STEPS = [
    ["Prepare the repo", "A Dockerfile at the repo root. The app listens on one port (8080 by default) and has a path that answers 200 without a login."],
    ["Give Lilypad read access", "One of three. Public repo: nothing to create, type public. Deploy key: run ssh-keygen -t ed25519 -N \"\" -f ~/.ssh/lilypad_<name>, add the .pub under the repo's Settings › Deploy keys (read-only, leave \"Allow write access\" off), and load the private key file. Or a fine-grained token with read-only Contents on that one repo."],
    ["Set up the demo", "New demo: pick a name, paste the repo and its GitHub access, choose port, health path and size."],
    ["Deploy", "Save & deploy. It takes 5–10 minutes. You get an email when it's live, or if it fails."],
    ["Share and iterate", "Send the link. Push new code, then Redeploy. Change settings with Edit settings, then Redeploy."],
    ["Clean up", "Demos expire after 30 days, with a warning on day 27. Extend adds 30 days, up to 90 in total. Destroy when you're done."],
  ];
  const FAQ = [
    ["The key email didn't arrive.", "It usually takes under a minute. Check spam or junk, and that you used your plain @" + EMAIL_DOMAIN + " address (no + aliases). You can ask for your key again once a minute."],
    ["Can I use the same key on several machines?", "Yes. Asking for your key again (here, or lilypad auth in the CLI) emails the same key while it is valid, so every copy keeps working. Turn on \u201cSend a new key instead\u201d (lilypad auth --new) only if the key leaked or is about to expire: the old key then stops working everywhere."],
    ["Why isn't my demo on the dashboard?", "The dashboard lists your demos that aren't destroyed (admins see everyone's). If one is missing, refresh, or open it by name at the bottom of the Demos page."],
    ["The build failed. What now?", "Open the demo and check the Build log tab: it shows the clone and docker build output. If the build passed but the app never got healthy, check App logs and the status report. The usual suspects: no Dockerfile at the root, the wrong port, or a health path that needs a login. Logs are kept 7 days."],
    ["How long does a demo live?", "30 days. You get a warning email on day 27. Extend moves the expiry to 30 days from now, up to 90 days in total."],
    ["Can I change settings after deploying?", "Yes: Edit settings, save, then Redeploy. The client part of the address is fixed after the first deploy; destroy and set up again to change it."],
    ["Can I put secrets in environment variables?", "No. Platform operators can read them. Use test credentials only."],
    ["How many demos can I run?", "Five active demos per person (25 for sales, 50 for elite and admins); ask a Lilypad admin if you need the sales or elite role. Destroy one to free a slot. Demos an admin made permanent don't count."],
    ["Who can open or manage my demo?", "Anyone with the link can open the app itself, so add your own login if it needs one. Only you and Lilypad admins can see its status, app logs and build log, deploy or redeploy it, extend it or destroy it. Only you can change its settings."],
    ["Where is my key kept?", "In this browser's local storage. Sign out removes it. Requesting a new key replaces the old one everywhere."],
    ["Keyboard shortcuts?", "/ search · n new demo · r refresh · ? help · Esc closes panels and menus."],
  ];
  const helpGrid = (steps) => h("div", { class: "help-grid" }, steps.map((s, i) => h("div", { class: "card help-step" }, h("div", { class: "n", text: String(i + 1) }), h("h3", { text: s[0] }), h("p", { text: s[1] }))));
  const helpList = (steps) => h("ol", { class: "help-list" }, steps.map((s) => h("li", null, h("strong", { text: s[0] }), h("span", { text: s[1] }))));

  // #/help without a key: the same guide, no platform calls.
  function renderPublicHelp() {
    const app = clear($("#app"));
    S.page = "";
    app.append(h("header", { class: "topbar" }, h("div", { class: "topbar-in" }, brand(true), h("div", { class: "spacer" }),
      btn("Sign in", { cls: "btn-primary", icon: "i-key", href: "#/welcome" }))),
      h("main", { class: "page", id: "main", tabindex: "-1" }));
    renderHelp($("#main"), false);
    window.scrollTo(0, 0);
  }

  // The onboarding guide: a scrollable modal, so the step in progress is kept.
  function helpModal() {
    const prev = document.activeElement;
    const close = btn("Close", { cls: "btn-primary" });
    const scrim = h("div", { class: "scrim modal-scrim" });
    const card = h("div", { class: "modal-card modal-wide", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title" },
      h("div", { class: "modal-ico ok" }, icon("i-help")),
      h("h2", { id: "modal-title", text: "How to set up and deploy" }),
      h("p", { text: "From a GitHub repo to a shareable HTTPS demo." }),
      h("h3", { class: "help-h", text: "1. Get access" }), helpList(ACCESS_STEPS),
      h("h3", { class: "help-h", text: "2. Deploy a demo" }), helpList(DEPLOY_STEPS),
      h("div", { class: "modal-actions" }, btn("Full guide & FAQ", { cls: "btn-ghost", icon: "i-external", href: "#/help", external: true }), close));
    const wrap = h("div", { class: "modal" }, card);
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); done(); } }
    function done() { scrim.remove(); wrap.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); }
    close.addEventListener("click", done);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(scrim, wrap);
    close.focus();
  }

  function renderHelp(main, signedIn) {
    if (!signedIn) {
      add(main, [
        h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "How Lilypad works" }),
          h("p", { class: "sub", text: "Sign in, then go from a GitHub repo to a shareable HTTPS demo." }))),
        h("h2", { class: "section-h", text: "Get access" }), helpGrid(ACCESS_STEPS),
        h("h2", { class: "section-h", text: "Deploy a demo" }), helpGrid(DEPLOY_STEPS),
        h("h2", { class: "section-h", text: "Questions" }),
        h("div", { class: "card faq" }, FAQ.map((f) => h("details", null, h("summary", { text: f[0] }), h("p", { text: f[1] })))),
      ]);
      return;
    }
    const raw = h("textarea", { class: "textarea", id: "raw-body", spellcheck: "false", "aria-label": "Request body" });
    raw.value = '{"action":"whoami"}';
    const out = h("pre", { class: "raw-out", hidden: true });
    const send = btn("Send", { cls: "btn-primary", icon: "i-right" });
    send.addEventListener("click", async () => {
      let body;
      try { body = JSON.parse(raw.value); } catch (e) { out.hidden = false; out.textContent = "Not valid JSON: " + e.message; return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { out.hidden = false; out.textContent = "The body must be a JSON object."; return; }
      busyBtn(send, true);
      const r = await api(body);
      busyBtn(send, false);
      const shown = {};
      for (const k of Object.keys(r)) if (k !== "code") shown[k] = r[k];
      out.hidden = false;
      out.textContent = (r.code ? "HTTP " + r.code : "No response") + "\n\n" + JSON.stringify(shown, null, 2);
    });
    add(main, [
      h("div", { class: "page-head" }, h("div", { class: "grow" }, h("h1", { text: "How Lilypad works" }),
        h("p", { class: "sub", text: "From a GitHub repo to a shareable HTTPS demo in six steps." })),
        btn("New demo", { cls: "btn-primary btn-lg", icon: "i-plus", href: "#/new" })),
      helpGrid(DEPLOY_STEPS),
      h("h2", { class: "section-h", text: "Questions" }),
      h("div", { class: "card faq" }, FAQ.map((f) => h("details", null, h("summary", { text: f[0] }), h("p", { text: f[1] })))),
      h("h2", { class: "section-h", text: "Advanced" }),
      h("div", { class: "card card-pad" },
        h("h3", { text: "Raw request" }),
        h("p", { class: "hint", style: { margin: "4px 0 12px" } }, "Send any JSON body, like ", h("code", { text: "lilypad -" }), " in the CLI. Your key is added for you."),
        raw, h("div", { class: "row mt-8" }, send), out),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------
  function renderSettings(main) {
    const exp = S.me && S.me.keyExpiresAt;
    const url = h("input", { class: "input", id: "set-url", type: "url", value: apiUrl(), autocomplete: "off", spellcheck: "false", "aria-label": "Platform URL" });
    const saveUrl = btn("Save", { cls: "btn-primary" });
    saveUrl.addEventListener("click", async () => {
      const u = url.value.trim();
      if (!validPlatformUrl(u)) { toast("The URL must start with https://", "err"); return; }
      if (u === S.cfg.apiUrl) store.del(K.url); else store.set(K.url, u);
      toast("Platform URL saved", "ok", 2000);
      S.loaded = false; await whoami(); refreshAll();
    });
    const theme = store.get(K.theme) || "system";
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Theme" },
      [["system", "System", "i-monitor"], ["light", "Light", "i-sun"], ["dark", "Dark", "i-moon"]].map(([id, label, ic]) => h("button", {
        type: "button", "aria-pressed": theme === id ? "true" : "false",
        onclick: (e) => {
          if (id === "system") store.del(K.theme); else store.set(K.theme, id);
          applyTheme();
          e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
          e.currentTarget.setAttribute("aria-pressed", "true");
        },
      }, icon(ic, "icon-s"), label)));
    const sel = h("select", { class: "select", style: { maxWidth: "220px" }, "aria-label": "Auto-refresh" }, REFRESH_OPTS.map((o) => h("option", { value: String(o[0]), text: o[0] ? "Every " + o[1] : "Off", selected: o[0] === refreshMs() })));
    sel.addEventListener("change", () => { store.set(K.refresh, sel.value); schedule(); toast("Saved", "ok", 1500); });
    const setRow = (title, hint, ...ctl) => h("div", { class: "set-row" }, h("div", null, h("h3", { text: title }), hint ? h("p", { class: "hint", text: hint }) : null), h("div", { class: "stack" }, ctl));
    add(main, [
      h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Settings" }), h("p", { class: "sub", text: "Your account and how this browser talks to Lilypad." }))),
      h("div", { class: "settings stack" },
        h("div", { class: "card" },
          setRow("Account", "You sign in with an emailed key. Nothing else about you is stored here.",
            S.me ? h("div", { class: "id-card" }, h("span", { class: "avatar", text: initials(S.me.email) }),
              h("div", null, h("strong", { text: S.me.email }), " ", adminTag(), h("div", { class: "hint", text: exp ? "Key expires " + fmtDate(exp) + " (" + fmtRel(exp) + ")" : "Key verified" })))
              : h("p", { class: "hint", text: "Key not verified yet." }),
            isAdmin() ? h("p", { class: "hint", text: "As an admin you see every demo, and can view app and build logs, deploy, redeploy, extend and destroy any of them. Editing settings stays with each demo's creator, who gets a note when you deploy their demo." }) : null,
            h("div", { class: "row" }, btn("Get a new key", { icon: "i-key", href: "#/welcome?step=email" }), btn("Sign out", { cls: "btn-danger", icon: "i-logout", onclick: signOut }))),
          setRow("Platform URL", S.cfg.apiUrl ? "Provided by this site. Change it only if your admin asks you to." : "From your Lilypad admin.",
            h("div", { class: "row" }, h("div", { class: "grow" }, url), saveUrl))),
        h("div", { class: "card" },
          setRow("Appearance", "Follow your system, or pick one.", seg),
          setRow("Auto-refresh", "How often the dashboard checks for changes. An open demo that's building is checked every 10 seconds.", sel)),
        h("div", { class: "card" },
          setRow("This browser", "Demos you set up or opened here stay on your dashboard even when the platform doesn't list them.",
            h("div", { class: "row" },
              btn("Forget opened demos", { onclick: () => { store.del(K.tracked); S.demos = new Map(); S.loaded = false; refreshAll(); toast("Forgotten", "ok", 1500); } }),
              btn("Reset everything", { cls: "btn-danger", icon: "i-trash", onclick: async () => {
                if (!(await modal({ title: "Reset this browser?", danger: true, confirm: "Reset", body: "Removes your key, the platform URL and all preferences from this browser." }))) return;
                Object.values(K).forEach((k) => store.del(k));
                S.me = null; S.demos = new Map(); S.loaded = false; S.onb = { step: "", email: "", sent: false, error: "" };
                applyTheme(); schedule(); go("welcome");
              } }))))),
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (S.menu) { const a = S.menu.anchor; closeMenu(); a.focus(); return; }
      if (S.drawer && !$(".modal")) { go("demos"); return; }
    }
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    if (!hasKey() || !$(".topbar") || $(".modal")) return;
    if (e.key === "/" && $("#q")) { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "n") { e.preventDefault(); go("new"); }
    else if (e.key === "r" && $("#grid")) { e.preventDefault(); refreshAll({ deep: true }); }
    else if (e.key === "?") { e.preventDefault(); go("help"); }
  });

  // ---------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------
  async function loadConfig() {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      if (j && typeof j.apiUrl === "string" && /^https:\/\/\S+$/.test(j.apiUrl.trim())) S.cfg.apiUrl = j.apiUrl.trim();
      if (j && typeof j.demoDomain === "string" && /^[a-z0-9.-]+$/i.test(j.demoDomain)) S.cfg.demoDomain = j.demoDomain;
    } catch (e) { /* optional */ }
  }

  async function start() {
    applyTheme();
    await loadConfig();
    for (const n of tracked()) S.demos.set(n, { name: n, status: "UNKNOWN" });
    render();
    if (apiUrl() && hasKey()) {
      await whoami();
      if (route().view !== "welcome") refreshAll();
    }
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
