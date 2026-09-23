const params = new URLSearchParams(location.search);
const editing = params.has("edit");
const noedit = params.has("noedit");

const wrap = document.getElementById("wrap");
const insp = document.getElementById("insp");
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
  if (!st || !cells.length) return;
  st.p.forEach((on, i) => {
    const c = cells[i];
    if (c) c.classList.toggle("on", on);
  });
  st.c.forEach((n, i) => {
    const c = cells[i];
    const cnt = c && c.querySelector(".cnt");
    if (cnt) cnt.textContent = n;
  });
}

function onCfg(c, mid) {
  cfg = c;
  for (const cell of cfg.cells) {
    if (cell.kind === "key" && !Array.isArray(cell.keys)) cell.keys = [];
  }
  render();
  const force = mid === "captured" || mid === "saved";
  if (pendingSelect !== null) {
    const nc = cfg.cells[pendingSelect];
    if (nc) sel = nc.id;
    pendingSelect = null;
    renderInsp();
  } else if (sel && !cfg.cells.find((x) => x.id === sel)) {
    sel = null;
    renderInsp();
  } else if (editing && (force || !inspContainsFocus())) {
    renderInsp();
  }
}

function inspContainsFocus() {
  return insp.contains(document.activeElement);
}

function render() {
  if (!cfg) return;
  wrap.style.width = cfg.size.w + "px";
  wrap.style.height = cfg.size.h + "px";
  wrap.innerHTML = "";
  cells = cfg.cells.map((cell) => buildCell(cell));
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
  const w = 90;
  const h = 72;
  const hmax = (cfg.size && cfg.size.h) || 206;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const x = 14 + c * (w + 8);
      const y = 14 + r * (h + 8);
      if (y + h > hmax + 40) continue;
      let ok = true;
      for (const o of cfg.cells) {
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
  if (!cfg) {
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
  else cell.image = "madeline_like_hihi.png";
  cfg.cells.push(cell);
  pendingSelect = cfg.cells.length - 1;
  send({ t: "cfg", cfg: JSON.parse(JSON.stringify(cfg)) });
}

function deleteCell(id) {
  cfg.cells = cfg.cells.filter((c) => c.id !== id);
  sel = null;
  send({ t: "cfg", cfg: JSON.parse(JSON.stringify(cfg)) });
  renderInsp();
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
  const cell = cfg.cells.find((c) => c.id === sel);
  if (!cell) {
    insp.innerHTML =
      '<div class="hint">Select a cell to edit it.<br /><br />Drag cells to move them, use the corner handle to resize.<br /><br />Add key cells or image cells with the buttons above.</div>';
    return;
  }

  const box = document.createElement("div");

  const nameField = inpText(cell.label, "dash");
  nameField.addEventListener("input", () => {
    cell.label = nameField.value;
    render();
    saveCfgDebounced();
  });
  box.appendChild(section("Cell", field("Label", nameField)));

  if (cell.kind === "image") {
    const imgField = inpText(cell.image, "image.png");
    imgField.addEventListener("input", () => {
      cell.image = imgField.value;
      render();
      saveCfgDebounced();
    });
    box.appendChild(section("Image", field("File (relative to /web)", imgField)));
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
    const addBtn = document.createElement("button");
    addBtn.textContent = "add";
    const listenBtn = document.createElement("button");
    listenBtn.textContent = "listen";
    listenBtn.className = "listen-btn";
    addBtn.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) return;
      cell.keys.push(v);
      input.value = "";
      saveCfg();
      renderInsp();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.click();
    });
    listenBtn.addEventListener("click", () => send({ t: "cap", id: cell.id }));
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
    lsz.addEventListener("change", () => {
      const v = parseInt(lsz.value, 10);
      if (v >= 8 && v <= 96) {
        cell.labelSize = v;
        saveCfg();
        render();
      }
    });
    box.appendChild(section("Label size", field("font size (px) of the label", lsz)));
  }

  const appFields = [];
  if (cell.kind !== "image") {
    const fnt = selFont(cell.font);
    fnt.addEventListener("change", () => {
      cell.font = fnt.value;
      saveCfg();
      render();
    });
    appFields.push(field("font family of the label", fnt));
  }
  const scv = numVal(cell.scale || 1);
  scv.step = "0.25";
  scv.min = "0.25";
  scv.max = "4";
  scv.addEventListener("change", () => {
    const v = parseFloat(scv.value);
    if (!v || v < 0.25 || v > 4) {
      scv.value = cell.scale || 1;
      return;
    }
    cell.scale = v;
    saveCfg();
    render();
  });
  appFields.push(field("scale (zoom) of the cell", scv));
  box.appendChild(section("Appearance", ...appFields));

  const mkNum = (key) => {
    const i = numVal(cell[key]);
    i.addEventListener("change", () => {
      let v = parseInt(i.value, 10) || 0;
      if (key === "w" || key === "h") v = Math.max(30, v);
      if (key === "x" || key === "y") v = Math.max(0, v);
      cell[key] = v;
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
  box.appendChild(section("Layout (px, canvas " + cfg.size.w + "x" + cfg.size.h + ")", r1, r2));

  const btnRow = document.createElement("div");
  btnRow.className = "row";
  const del = document.createElement("button");
  del.textContent = "Delete cell";
  del.style.borderColor = "#8f5a5a";
  del.addEventListener("click", () => deleteCell(cell.id));
  const reset = document.createElement("button");
  reset.textContent = "Reset count";
  reset.addEventListener("click", () => send({ t: "reset", id: cell.id }));
  btnRow.appendChild(del);
  btnRow.appendChild(reset);
  box.appendChild(btnRow);

  insp.innerHTML = "";
  insp.appendChild(box);
}

connect();