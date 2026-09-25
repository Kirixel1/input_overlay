const params = new URLSearchParams(location.search);
const editing = params.has("edit");
const noedit = params.has("noedit");

const wrap = document.getElementById("wrap");
const side = document.getElementById("side");
const insp = document.getElementById("insp");
const ovbar = document.getElementById("ovbar");
const toastEl = document.getElementById("toast");
const gear = document.getElementById("gear");

document.body.classList.toggle("editing", editing);
gear.hidden = editing || noedit;
gear.addEventListener("click", () => {
  location.search = "?edit=1";
});

if (editing && !noedit) {
  document.getElementById("btnDone").addEventListener("click", () => {
    location.search = "";
  });
  document.getElementById("btnAddKey").addEventListener("click", () => addCell("key"));
  document.getElementById("btnAddImg").addEventListener("click", () => addCell("image"));
  document.getElementById("btnResetAll").addEventListener("click", () => send({ t: "resetall" }));
}

let cfg = null;
let st = null;
let sel = null;
let pendingSelect = null;
let ws;
let cells = [];
let toastTimer = 0;
let saveTimer = 0;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

async function fetchMedia() {
  const r = await fetch("/api/media");
  const j = await r.json();
  return (j.files || []).sort();
}

function ov() {
  if (!cfg || !Array.isArray(cfg.overlays) || !cfg.overlays.length) return null;
  const i = Math.min(Math.max(0, cfg.active || 0), cfg.overlays.length - 1);
  return cfg.overlays[i];
}

function ovToken() {
  const t = params.get("ov") || params.get("t");
  if (t) return t;
  for (const [k, v] of params) {
    if (v === "" && k !== "edit" && k !== "noedit") return k;
  }
  return null;
}

function matchOverlay(p) {
  if (!p || !cfg || !Array.isArray(cfg.overlays)) return null;
  const want = String(p).trim().toLowerCase();
  if (!want) return null;
  const byId = cfg.overlays.find((o) => String(o.id).toLowerCase() === want);
  if (byId) return byId;
  const byName = cfg.overlays.find((o) => String(o.name || "").trim().toLowerCase() === want);
  if (byName) return byName;
  const idx = parseInt(p, 10);
  if (!isNaN(idx) && idx >= 0 && idx < cfg.overlays.length) return cfg.overlays[idx];
  return null;
}

function ovParam() {
  return matchOverlay(ovToken());
}

function viewedOverlay() {
  if (editing) return ov();
  const tok = ovToken();
  if (tok) return matchOverlay(tok);
  return ov();
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    send({ t: "cfg" });
    showToast("connected");
  };
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.t === "cfg") onCfg(d.cfg, d.mid);
    else if (d.t === "st") onSt(d);
    else if (d.t === "toast") showToast(d.m);
  };
  ws.onclose = () => setTimeout(connect, 500);
}

function send(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function showToast(m) {
  toastEl.textContent = m;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function onSt(d) {
  st = d;
  applySt();
}

function applySt() {
  const v = viewedOverlay();
  if (!st || !v || !cells.length) return;
  const p = st.p[v.id];
  const c = st.c[v.id];
  if (!p || !c || p.length !== cells.length) return;
  p.forEach((on, i) => {
    const el = cells[i];
    if (el) el.classList.toggle("on", on);
  });
  c.forEach((n, i) => {
    const el = cells[i];
    const cnt = el && el.querySelector(".cnt");
    if (cnt) cnt.textContent = n;
  });
}

function ensureKeyArrays() {
  for (const o of cfg.overlays) {
    for (const cell of o.cells) {
      if (cell.kind === "key" && !Array.isArray(cell.keys)) cell.keys = [];
    }
  }
}

function editorFocused() {
  return side.contains(document.activeElement);
}

function onCfg(c, mid) {
  cfg = c;
  ensureKeyArrays();
  render();
  const force = mid === "captured" || (mid === "saved" && !editorFocused());
  if (pendingSelect !== null) {
    const nc = ov().cells[pendingSelect];
    if (nc) sel = nc.id;
    pendingSelect = null;
    renderSide();
  } else if (sel && !ov().cells.find((x) => x.id === sel)) {
    sel = null;
    renderSide();
  } else if (editing && (force || !editorFocused())) {
    renderSide();
  }
}

function renderSide() {
  renderOvBar();
  renderInsp();
}

function captureSideFocus() {
  const el = document.activeElement;
  if (!el || !side.contains(el)) return null;
  const f = el.getAttribute("data-f");
  if (f == null) return null;
  return { f, sel: el.selectionStart };
}

function restoreSideFocus(s) {
  if (!s) return;
  const el = side.querySelector('[data-f="' + s.f + '"]');
  if (!el) return;
  el.focus();
  if (typeof s.sel === "number" && typeof el.setSelectionRange === "function") {
    const pos = Math.min(s.sel, (el.value || "").length);
    el.setSelectionRange(pos, pos);
  }
}

let lastRenderKey = null;

function cellSig(c) {
  return [
    c.id, c.kind, c.label, c.labelSize, c.showCounter, c.image,
    c.x, c.y, c.w, c.h, c.font, c.scale, c.onBg, c.onBorder,
  ].join("\u0001");
}

function render() {
  const v = viewedOverlay();
  if (!v) {
    cells = [];
    lastRenderKey = null;
    wrap.innerHTML = "";
    if (cfg && !editing) {
      const tok = ovToken();
      if (tok) {
        const warn = document.createElement("div");
        warn.className = "ovmissing";
        warn.textContent = "overlay not found: " + tok;
        wrap.appendChild(warn);
      }
    }
    return;
  }
  wrap.style.width = v.size.w + "px";
  wrap.style.height = v.size.h + "px";
  const key = v.cells.map(cellSig).join("\u0002") + "\u0003" + (editing ? "e" : "v");
  if (key === lastRenderKey) {
    v.cells.forEach((c, i) => {
      if (cells[i]) cells[i].classList.toggle("selected", c.id === sel);
    });
    applySt();
    return;
  }
  lastRenderKey = key;
  wrap.innerHTML = "";
  cells = v.cells.map((cell) => buildCell(cell));
  for (const el of cells) wrap.appendChild(el);
  applySt();
}

function buildCell(cell) {
  const el = document.createElement("div");
  const isImg = cell.kind === "image";
  el.className =
    "cell" +
    (isImg ? " image" : "") +
    (cell.showCounter ? "" : " no-cnt") +
    (cell.id === sel ? " selected" : "");
  el.style.left = cell.x + "px";
  el.style.top = cell.y + "px";
  el.style.width = cell.w + "px";
  el.style.height = cell.h + "px";
  if (cell.onBg) el.style.setProperty("--on-bg", cell.onBg);
  if (cell.onBorder) el.style.setProperty("--on-border", cell.onBorder);
  if (cell.font) el.style.setProperty("--font", cell.font);
  if (cell.scale && cell.scale !== 1) {
    el.style.transform = "scale(" + cell.scale + ")";
    el.style.transformOrigin = "0px 0px";
  }
  if (isImg) {
    el.innerHTML = `<img src="${esc(cell.image || "")}" alt="" draggable="false" />`;
  } else {
    el.innerHTML = `<span class="lbl" style="font-size:${cell.labelSize || 24}px">${esc(cell.label)}</span><span class="cnt">0</span>`;
  }
  if (editing) {
    attachDrag(el, cell);
    attachResize(el, cell);
    const del = document.createElement("button");
    del.className = "xdel";
    del.textContent = "×";
    del.title = "Delete cell";
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCell(cell.id);
    });
    el.appendChild(del);
  }
  return el;
}

function saveCfg() {
  send({ t: "cfg", cfg: JSON.parse(JSON.stringify(cfg)) });
  render();
}

function saveCfgDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCfg, 350);
}

function select(id) {
  sel = id;
  render();
  renderInsp();
}

function snapX(v, cell) {
  const step = cell.w + 8;
  return 14 + Math.round((v - 14) / step) * step;
}

function snapY(v, cell) {
  const step = cell.h + 8;
  return 14 + Math.round((v - 14) / step) * step;
}

function attachDrag(el, cell) {
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".rz") || e.target.closest(".xdel") || e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = cell.x;
    const oy = cell.y;
    let moved = false;
    const snapOn = document.getElementById("chkSnap") && document.getElementById("chkSnap").checked;
    const mv = (ev) => {
      if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3) moved = true;
      if (!moved) return;
      let nx = ox + ev.clientX - sx;
      let ny = oy + ev.clientY - sy;
      if (snapOn) {
        nx = snapX(nx, cell);
        ny = snapY(ny, cell);
      }
      cell.x = Math.max(0, nx);
      cell.y = Math.max(0, ny);
      el.style.left = cell.x + "px";
      el.style.top = cell.y + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      if (moved) saveCfg();
      else select(cell.id);
    };
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", up);
  });
}

function attachResize(el, cell) {
  const rz = document.createElement("div");
  rz.className = "rz";
  el.appendChild(rz);
  rz.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    rz.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = cell.w;
    const oh = cell.h;
    const mv = (ev) => {
      cell.w = Math.max(30, 10 * Math.round((ow + ev.clientX - sx) / 10));
      cell.h = Math.max(30, 10 * Math.round((oh + ev.clientY - sy) / 10));
      el.style.width = cell.w + "px";
      el.style.height = cell.h + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", mv);
      document.removeEventListener("pointerup", up);
      saveCfg();
    };
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", up);
  });
}

function freeSlot(kind) {
  const v = ov();
  const w = 90;
  const h = 72;
  const hmax = (v && v.size.h) || 206;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const x = 14 + c * (w + 8);
      const y = 14 + r * (h + 8);
      if (y + h > hmax + 40) continue;
      let ok = true;
      for (const o of v.cells) {
        if (x < o.x + o.w + 8 && x + w + 8 > o.x && y < o.y + o.h + 8 && y + h + 8 > o.y) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, y };
    }
  }
  return { x: 14, y: 14 };
}

function addCell(kind) {
  const v = ov();
  if (!v) {
    showToast("no connection to the overlay server");
    return;
  }
  const p = freeSlot(kind);
  const cell = {
    id: "",
    kind: kind,
    label: kind === "key" ? "Key" : "Image",
    labelSize: 24,
    showCounter: kind === "key",
    x: p.x,
    y: p.y,
    w: 90,
    h: 72,
  };
  if (kind === "key") cell.keys = [];
  else cell.image = "media/madeline_like_hihi.png";
  v.cells.push(cell);
  pendingSelect = v.cells.length - 1;
  send({ t: "cfg", cfg: JSON.parse(JSON.stringify(cfg)) });
}

function deleteCell(id) {
  const v = ov();
  v.cells = v.cells.filter((c) => c.id !== id);
  sel = null;
  send({ t: "cfg", cfg: JSON.parse(JSON.stringify(cfg)) });
  renderInsp();
}

function switchOverlay(i) {
  if (!cfg || i < 0 || i >= cfg.overlays.length) return;
  cfg.active = i;
  sel = null;
  pendingSelect = null;
  saveCfg();
  renderSide();
}

function renderOvBar() {
  if (!editing || !cfg) return;
  const box = ovbar;
  box.innerHTML = "";
  const selOv = document.createElement("select");
  selOv.dataset.f = "ovsel";
  cfg.overlays.forEach((o, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = o.name || o.id || "Overlay " + (i + 1);
    if (i === cfg.active) opt.selected = true;
    selOv.appendChild(opt);
  });
  selOv.addEventListener("change", () => switchOverlay(parseInt(selOv.value, 10)));

  const nameEl = document.createElement("input");
  nameEl.type = "text";
  nameEl.dataset.f = "ovname";
  nameEl.value = ov().name || "";
  nameEl.placeholder = "overlay name";
  nameEl.title = "Overlay name";
  nameEl.addEventListener("input", () => {
    ov().name = nameEl.value;
    if (linkEl) linkEl.value = ovUrl(ov());
    saveCfgDebounced();
  });
  nameEl.addEventListener("keydown", (e) => e.stopPropagation());

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ overlay";
  addBtn.title = "Add a new empty overlay";
  addBtn.addEventListener("click", () => {
    const name = "Overlay " + (cfg.overlays.length + 1);
    cfg.overlays.push({ id: "", name: name, size: { w: 510, h: 206 }, cells: [] });
    switchOverlay(cfg.overlays.length - 1);
  });

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "copy";
  copyBtn.title = "Duplicate the current overlay";
  copyBtn.addEventListener("click", () => {
    const src = ov();
    const cpy = JSON.parse(JSON.stringify(src));
    cpy.id = "";
    cpy.name = src.name + " (copy)";
    for (let i = 0; i < cpy.cells.length; i++) cpy.cells[i].id = cpy.cells[i].id + "-copy-" + (i + 1);
    cfg.overlays.push(cpy);
    switchOverlay(cfg.overlays.length - 1);
  });

  const delBtn = document.createElement("button");
  delBtn.textContent = "delete";
  delBtn.title = "Delete the current overlay";
  delBtn.style.borderColor = "#8f5a5a";
  delBtn.addEventListener("click", () => {
    if (cfg.overlays.length <= 1) {
      showToast("cannot delete the only overlay");
      return;
    }
    cfg.overlays.splice(cfg.active, 1);
    if (cfg.active >= cfg.overlays.length) cfg.active = cfg.overlays.length - 1;
    sel = null;
    pendingSelect = null;
    saveCfg();
    renderSide();
  });

  box.appendChild(selOv);
  box.appendChild(nameEl);
  box.appendChild(addBtn);
  box.appendChild(copyBtn);
  box.appendChild(delBtn);

  const linkRow = document.createElement("div");
  linkRow.className = "ovlink";
  const linkEl = document.createElement("input");
  linkEl.type = "text";
  linkEl.className = "ovlinkurl";
  linkEl.readOnly = true;
  linkEl.title = "OBS Browser Source URL for this overlay";
  linkEl.value = ovUrl(ov());
  linkEl.addEventListener("focus", () => linkEl.select());
  const linkBtn = document.createElement("button");
  linkBtn.textContent = "copy link";
  linkBtn.title = "Copy the OBS Browser Source URL for this overlay";
  linkBtn.addEventListener("click", async () => {
    const url = linkEl.value;
    try {
      await navigator.clipboard.writeText(url);
      showToast("link copied");
    } catch (e) {
      linkEl.focus();
      linkEl.select();
      showToast("press Ctrl+C to copy");
    }
  });
  linkRow.appendChild(linkEl);
  linkRow.appendChild(linkBtn);
  box.appendChild(linkRow);
}

function ovUrl(v) {
  const name = (v && (v.name || v.id)) || "";
  return location.origin + "/?noedit=1&t=" + encodeURIComponent(name);
}

function section(title, ...nodes) {
  const h = document.createElement("div");
  h.className = "sec";
  const cap = document.createElement("div");
  cap.className = "scap";
  cap.innerHTML = title;
  h.appendChild(cap);
  nodes.forEach((n) => h.appendChild(n));
  return h;
}

function field(txt, ...nodes) {
  const f = document.createElement("div");
  f.className = "f";
  const l = document.createElement("label");
  l.innerHTML = txt;
  f.appendChild(l);
  nodes.forEach((n) => f.appendChild(n));
  return f;
}

function inpText(init, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  if (init) i.value = init;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function numVal(init) {
  const i = document.createElement("input");
  i.type = "number";
  i.value = init;
  return i;
}

function chk(init) {
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = init;
  return c;
}

function selFont(init) {
  const s = document.createElement("select");
  const opts = [
    ["", "Iosevka (default)"],
    ["ui-monospace, SFMono-Regular, monospace", "Monospace"],
    ["system-ui, Segoe UI, sans-serif", "Sans-serif"],
    ["Georgia, 'Times New Roman', serif", "Serif"],
  ];
  for (const [v, t] of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (v === (init || "")) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function renderInsp() {
  if (!cfg) return;
  const v = ov();
  if (!v) return;
  const prev = captureSideFocus();
  const cell = v.cells.find((c) => c.id === sel);
  if (!cell) {
    insp.innerHTML =
      '<div class="hint">Select a cell to edit it.<br /><br />Drag cells to move them, use the corner handle to resize.<br /><br />Add key cells or image cells with the buttons above.<br /><br />Overlays: pick one from the list above, or add/copy/delete your own (e.g. for Isaac, osu!mania, ...).</div>';
    return;
  }

  const box = document.createElement("div");

  const nameField = inpText(cell.label, "dash");
  nameField.dataset.f = "label";
  nameField.addEventListener("input", () => {
    cell.label = nameField.value;
    render();
    saveCfgDebounced();
  });
  box.appendChild(section("Cell", field("Label", nameField)));

  if (cell.kind === "image") {
    const imgField = inpText(cell.image, "media/image.png / anim.gif");
    imgField.dataset.f = "image";
    imgField.addEventListener("input", () => {
      cell.image = imgField.value;
      render();
      saveCfgDebounced();
    });
    const browseBtn = document.createElement("button");
    browseBtn.textContent = "browse";
    browseBtn.className = "browse-btn";
    const row = document.createElement("div");
    row.className = "row rowimg";
    row.appendChild(imgField);
    row.appendChild(browseBtn);
    const menu = document.createElement("div");
    menu.className = "media-menu";
    menu.style.display = "none";
    const showMenu = () => {
      menu.style.display = "block";
      menu.textContent = "loading…";
      fetchMedia()
        .then((files) => {
          menu.textContent = "";
          if (!files.length) {
            const em = document.createElement("div");
            em.className = "media-empty";
            em.textContent = "no png/jpg/gif files in web/";
            menu.appendChild(em);
            return;
          }
          files.forEach((f) => {
            const it = document.createElement("button");
            it.className = "media-item";
            it.title = f;
            const th = document.createElement("img");
            th.src = "/media/" + encodeURI(f);
            it.appendChild(th);
            const nm = document.createElement("span");
            nm.textContent = f;
            it.appendChild(nm);
            it.addEventListener("click", () => {
              cell.image = "media/" + f;
              imgField.value = cell.image;
              menu.style.display = "none";
              saveCfg();
              render();
            });
            menu.appendChild(it);
          });
        })
        .catch(() => {
          menu.textContent = "failed to load files";
        });
    };
    browseBtn.addEventListener("click", () => {
      if (menu.style.display === "none") showMenu();
      else menu.style.display = "none";
    });
    box.appendChild(section("Image", row, menu));
  } else {
    const keysBox = document.createElement("div");
    keysBox.className = "chips";
    cell.keys.forEach((k) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = k;
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.title = "unbind";
      x.addEventListener("click", () => {
        cell.keys = cell.keys.filter((kk) => kk !== k);
        saveCfg();
        renderInsp();
      });
      chip.appendChild(x);
      keysBox.appendChild(chip);
    });

    const input = inpText("", "KEY_H, A, or 35");
    input.dataset.f = "key";
    const addBtn = document.createElement("button");
    addBtn.textContent = "add";
    const listenBtn = document.createElement("button");
    listenBtn.textContent = "listen";
    listenBtn.className = "listen-btn";
    addBtn.addEventListener("click", () => {
      const v2 = input.value.trim();
      if (!v2) return;
      cell.keys.push(v2);
      input.value = "";
      saveCfg();
      renderInsp();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.click();
    });
    listenBtn.addEventListener("click", () => send({ t: "cap", id: cell.id, ov: v.id }));
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(input);
    row.appendChild(addBtn);
    row.appendChild(listenBtn);
    box.appendChild(section("Keycodes", field("Bound keys", keysBox), row));

    const cb = chk(cell.showCounter);
    cb.addEventListener("change", () => {
      cell.showCounter = cb.checked;
      saveCfg();
      render();
    });
    box.appendChild(section("Counter", field("count and show the press counter", cb)));

    const lsz = numVal(cell.labelSize || 24);
    lsz.dataset.f = "labelSize";
    lsz.addEventListener("change", () => {
      const val = parseInt(lsz.value, 10);
      if (val >= 8 && val <= 96) {
        cell.labelSize = val;
        saveCfg();
        render();
      }
    });
    box.appendChild(section("Label size", field("font size (px) of the label", lsz)));
  }

  const appFields = [];
  if (cell.kind !== "image") {
    const fnt = selFont(cell.font);
    fnt.dataset.f = "font";
    fnt.addEventListener("change", () => {
      cell.font = fnt.value;
      saveCfg();
      render();
    });
    appFields.push(field("font family of the label", fnt));
  }
  const scv = numVal(cell.scale || 1);
  scv.dataset.f = "scale";
  scv.step = "0.25";
  scv.min = "0.25";
  scv.max = "4";
  scv.addEventListener("change", () => {
    const v3 = parseFloat(scv.value);
    if (!v3 || v3 < 0.25 || v3 > 4) {
      scv.value = cell.scale || 1;
      return;
    }
    cell.scale = v3;
    saveCfg();
    render();
  });
  appFields.push(field("scale (zoom) of the cell", scv));
  box.appendChild(section("Appearance", ...appFields));

  const mkColor = (key, txt) => {
    const wrap = document.createElement("div");
    wrap.className = "colorrow";
    const i = document.createElement("input");
    i.type = "color";
    i.dataset.f = "col-" + key;
    i.value = /^#[0-9a-fA-F]{6}$/.test(cell[key] || "") ? cell[key] : key === "onBg" ? "#1e78b4" : "#78d2ff";
    i.addEventListener("input", () => {
      cell[key] = i.value;
      saveCfgDebounced();
      render();
    });
    const clr = document.createElement("button");
    clr.textContent = "×";
    clr.title = "reset to default";
    clr.addEventListener("click", () => {
      delete cell[key];
      i.value = key === "onBg" ? "#1e78b4" : "#78d2ff";
      saveCfg();
      render();
    });
    wrap.appendChild(i);
    wrap.appendChild(clr);
    return field(txt, wrap);
  };

  if (cell.kind !== "image") {
    box.appendChild(section("Press color", mkColor("onBg", "pressed background"), mkColor("onBorder", "pressed border")));
  }

  const mkNum = (key) => {
    const i = numVal(cell[key]);
    i.dataset.f = "num-" + key;
    i.addEventListener("change", () => {
      let val = parseInt(i.value, 10) || 0;
      if (key === "w" || key === "h") val = Math.max(30, val);
      if (key === "x" || key === "y") val = Math.max(0, val);
      cell[key] = val;
      saveCfg();
      render();
    });
    return field(key, i);
  };
  const r1 = document.createElement("div");
  r1.className = "row";
  r1.appendChild(mkNum("x"));
  r1.appendChild(mkNum("y"));
  const r2 = document.createElement("div");
  r2.className = "row";
  r2.appendChild(mkNum("w"));
  r2.appendChild(mkNum("h"));
  box.appendChild(section("Layout (px, canvas " + v.size.w + "x" + v.size.h + ")", r1, r2));

  const btnRow = document.createElement("div");
  btnRow.className = "row";
  const del = document.createElement("button");
  del.textContent = "Delete cell";
  del.style.borderColor = "#8f5a5a";
  del.addEventListener("click", () => deleteCell(cell.id));
  const reset = document.createElement("button");
  reset.textContent = "Reset count";
  reset.addEventListener("click", () => send({ t: "reset", id: cell.id, ov: v.id }));
  btnRow.appendChild(del);
  btnRow.appendChild(reset);
  box.appendChild(btnRow);

  insp.innerHTML = "";
  insp.appendChild(box);
  restoreSideFocus(prev);
}

connect();