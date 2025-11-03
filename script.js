/* ===== CONFIG ===== */
const USE_BACKEND = window.USE_BACKEND === true;
const BACKEND_BASE = window.BACKEND_BASE || "http://127.0.0.1:8000";

/* ===== STATE ===== */
let profile = {
  age: 21,
  region: "IN",
  allergies: [],
  ulcer: false,
  liver: false,
  brandMapper: true,
  explain: true,
  cost: true,
  lang: "en",
};
let selectedMeds = [];
let medicineDB = [];
let currentMode = "simple";
let radar = null;

const $ = (s) => document.querySelector(s);
const chat = $("#chatWindow");

/* ===== Chat bubbles ===== */
function addBubble(role, html) {
  const outer = document.createElement("div");
  outer.className = "msg-block";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role === "user" ? "user" : "bot"}`;
  bubble.innerHTML = html;
  outer.appendChild(bubble);
  chat.appendChild(outer);
  chat.scrollTop = chat.scrollHeight;
}
function md(txt) {
  return txt.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
}

/* ===== Local DB helpers ===== */
function searchMedicineLocal(query) {
  const q = (query || "").toLowerCase();
  return medicineDB.filter((m) => {
    const brandHit = (m.brands || []).some((b) =>
      b.brand.toLowerCase().includes(q)
    );
    const genericHit =
      m.name.toLowerCase().includes(q) || m.generic.toLowerCase().includes(q);
    const ingredientHit = (m.ingredients || []).some((i) =>
      i.toLowerCase().includes(q)
    );
    return brandHit || genericHit || ingredientHit;
  });
}
function checkInteractions(meds) {
  const warnings = [];
  const ids = meds.map((m) => m.id);
  if (ids.includes("ibuprofen") && ids.includes("amoxiclav"))
    warnings.push("⚠️ Monitor gastric side effects with NSAID + antibiotic.");
  if (ids.includes("paracetamol") && profile.liver)
    warnings.push(
      "⚠️ Paracetamol in liver issues: keep dose low and consult a clinician."
    );
  if (
    ids.includes("amoxiclav") &&
    (profile.allergies || []).map((x) => x.toLowerCase()).includes("penicillin")
  )
    warnings.push("⚠️ Penicillin allergy noted; avoid Amoxicillin/Clav.");
  return warnings;
}
function substituteAndOptimize(target) {
  const sameClass = medicineDB.filter(
    (m) => m.class === target.class && m.id !== target.id
  );
  const exactGeneric = medicineDB.filter(
    (m) =>
      (m.ingredients || []).length === (target.ingredients || []).length &&
      (m.ingredients || []).every((ing) => target.ingredients.includes(ing)) &&
      m.id !== target.id
  );
  const cheapest = [target, ...sameClass].sort(
    (a, b) => a.priceINR - b.priceINR
  )[0];
  const localBrands = (target.brands || [])
    .filter((b) => b.region === profile.region)
    .map((b) => b.brand);
  return { exactGeneric, sameClass, cheapest, localBrands };
}
function renderSelectedChips() {
  const wrap = $("#selectedMeds");
  wrap.innerHTML = "";
  selectedMeds.forEach((id) => {
    const m = medicineDB.find((x) => x.id === id);
    if (!m) return;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>💊 ${m.name}</span><button title="Alternatives">Alt</button>`;
    chip.querySelector("button").onclick = () => {
      const alt = substituteAndOptimize(m);
      const html = `
        <div class="kcard">
          <div class="krow"><div><b>${m.name}</b> — Alternatives</div></div>
          <div class="krow"><div><b>Local brands (${profile.region}):</b> ${
        (alt.localBrands || []).join(", ") || "—"
      }</div></div>
          <div class="krow"><div><b>Cheapest (demo price):</b> ${
            alt.cheapest?.name
          } (₹${alt.cheapest?.priceINR}/tab)</div></div>
          <div class="krow"><div><b>Exact generic:</b> ${
            alt.exactGeneric.map((x) => x.name).join(", ") || "—"
          }</div></div>
          <div class="krow"><div><b>Same class:</b> ${
            alt.sameClass.map((x) => x.name).join(", ") || "—"
          }</div></div>
        </div>`;
      addBubble("bot", html);
    };
    wrap.appendChild(chip);
  });
  const warnings = checkInteractions(
    selectedMeds
      .map((id) => medicineDB.find((m) => m.id === id))
      .filter(Boolean)
  );
  const list = $("#interactionList");
  list.innerHTML = warnings.length
    ? warnings.map((w) => `<li>${w}</li>`).join("")
    : `<li>No interactions flagged.</li>`;
  updateRiskRadar();
}

/* ===== Risk Radar (purple theme) ===== */
function riskScore() {
  const meds = selectedMeds
    .map((id) => medicineDB.find((m) => m.id === id))
    .filter(Boolean);
  let sedation = 0,
    gastro = 0,
    liver = 0,
    kidney = 0,
    inter = 0,
    allergy = 0;

  meds.forEach((m) => {
    const se = (m.sideEffects || []).map((x) => x.toLowerCase());
    if (se.some((s) => /drowsiness|sedation|fatigue/.test(s))) sedation += 25;
    if ((m.class || "").toLowerCase() === "nsaid") gastro += 40;
    if ((m.ingredients || []).some((i) => /paracetamol|acetaminophen/i.test(i)))
      liver += 40;
    if (m.contraindications?.some((c) => /kidney|renal/i.test(c))) kidney += 20;
  });
  if (profile.ulcer) gastro += 30;
  if (profile.liver) liver += 30;
  inter += Math.min(checkInteractions(meds).length * 25, 100);

  const allergies = (profile.allergies || []).map((a) => a.toLowerCase());
  if (allergies.includes("penicillin") && selectedMeds.includes("amoxiclav"))
    allergy += 100;

  const clamp = (v) => Math.max(0, Math.min(100, v));
  return {
    Sedation: clamp(sedation),
    Gastro: clamp(gastro),
    Liver: clamp(liver),
    Kidney: clamp(kidney),
    Interactions: clamp(inter),
    Allergy: clamp(allergy),
  };
}
function updateRiskRadar() {
  const data = riskScore();
  const labels = Object.keys(data);
  const values = labels.map((k) => data[k]);
  const ctx = $("#riskRadar").getContext("2d");
  if (radar) radar.destroy();
  radar = new Chart(ctx, {
    type: "radar",
    data: {
      labels,
      datasets: [
        {
          label: "Risk Profile",
          data: values,
          backgroundColor: "rgba(167,139,250,0.25)", // purple glass
          borderColor: "rgba(167,139,250,1)", // purple line
          pointBackgroundColor: "rgba(167,139,250,1)",
          borderWidth: 2,
        },
      ],
    },
    options: {
      scales: { r: { suggestedMin: 0, suggestedMax: 100 } },
      plugins: { legend: { display: false } },
    },
  });
}

/* ===== Chat (Explain Modes) ===== */
async function onSend() {
  const input = $("#input");
  const q = input.value.trim();
  if (!q) return;
  addBubble("user", q);
  input.value = "";

  if (!USE_BACKEND) {
    addBubble("bot", "Please enable backend in index.html (USE_BACKEND=true).");
    return;
  }

  try {
    const r = await fetch(`${BACKEND_BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, profile, mode: currentMode }),
    });
    const data = await r.json();
    const { simple, doctor, detected_medicines } = data;
    const html = `
      <div class="kcard">
        <div class="krow" style="justify-content:space-between; align-items:center;">
          <div><b>Answer</b></div>
          <div class="mode-toggle glass soft">
            <button class="seg ${
              currentMode === "simple" ? "active" : ""
            }" onclick="switchAnswerMode(this,'simple')">Simple</button>
            <button class="seg ${
              currentMode === "doctor" ? "active" : ""
            }" onclick="switchAnswerMode(this,'doctor')">Doctor</button>
          </div>
        </div>
        <div class="krow">
          <div id="ansSimple" style="display:${
            currentMode === "simple" ? "block" : "none"
          }">${(simple || "").replaceAll("\n", "<br/>")}</div>
          <div id="ansDoctor" style="display:${
            currentMode === "doctor" ? "block" : "none"
          }">${(doctor || "").replaceAll("\n", "<br/>")}</div>
        </div>
      </div>`;
    addBubble("bot", html);

    if (Array.isArray(detected_medicines)) {
      detected_medicines.forEach((name) => {
        const found = searchMedicineLocal(name)[0];
        if (found && !selectedMeds.includes(found.id))
          selectedMeds.push(found.id);
      });
      renderSelectedChips();
    }
  } catch (e) {
    addBubble("bot", "API error. Check backend is running.");
  }
}
window.switchAnswerMode = function (btn, mode) {
  currentMode = mode;
  const card = btn.closest(".kcard");
  card.querySelector("#ansSimple").style.display =
    mode === "simple" ? "block" : "none";
  card.querySelector("#ansDoctor").style.display =
    mode === "doctor" ? "block" : "none";
  const segs = card.querySelectorAll(".mode-toggle .seg");
  segs.forEach((s) =>
    s.classList.toggle(
      "active",
      s.textContent.toLowerCase() === (mode === "simple" ? "simple" : "doctor")
    )
  );
};

/* ===== Upload notice (left icon in composer) ===== */
function onUploadChange(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  addBubble("user", `Uploaded: ${f.name}`);
  addBubble(
    "bot",
    "For full report analysis, use the AI Report Summarizer tab →"
  );
}

/* ===== Summarizer ===== */
async function onSummarize() {
  const file = $("#reportFile").files?.[0];
  const status = $("#summarizeStatus");
  if (!file) {
    status.textContent = "Pick a PDF or image first.";
    return;
  }
  status.textContent = "Analyzing…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch(`${BACKEND_BASE}/summarize`, {
      method: "POST",
      body: fd,
    });
    const { summary, title, detected_medicines } = await r.json();
    const html = `<div class="kcard"><div class="krow"><div><b>AI Report Summary</b>${
      title ? ` — ${title}` : ""
    }</div></div><div class="krow"><div>${summary.replaceAll(
      "\n",
      "<br/>"
    )}</div></div></div>`;
    addBubble("bot", html);
    status.textContent = "Done.";
    if (Array.isArray(detected_medicines)) {
      detected_medicines.forEach((name) => {
        const found = searchMedicineLocal(name)[0];
        if (found && !selectedMeds.includes(found.id))
          selectedMeds.push(found.id);
      });
      renderSelectedChips();
    }
  } catch (e) {
    status.textContent = "Summarization failed. Check backend logs.";
  }
}

/* ===== Brand Mapper (deterministic) ===== */
function mapBrands() {
  const q = $("#mapperQuery").value.trim();
  const out = $("#mapResult");
  if (!q) {
    out.innerHTML = "Type a generic/brand first.";
    return;
  }
  const found = searchMedicineLocal(q);
  if (!found.length) {
    out.innerHTML =
      "No close match in demo DB. Try a generic name like Paracetamol.";
    return;
  }
  const m = found[0];
  const group = {};
  (m.brands || []).forEach((b) => {
    const k = b.region || "Global";
    (group[k] ||= []).push(b.brand);
  });
  const html = `
    <div><b>${m.name}</b> (${m.generic}) — Class: ${m.class}</div>
    <div class="hsep"></div>
    <div><b>Regional Brands</b></div>
    <ul class="list">${Object.keys(group)
      .map((r) => `<li><b>${r}:</b> ${group[r].join(", ")}</li>`)
      .join("")}</ul>
    <div class="muted small">Tip: Add to Selected Medicines to view risks & alternatives.</div>`;
  out.innerHTML = html;
  if (!selectedMeds.includes(m.id)) {
    selectedMeds.push(m.id);
    renderSelectedChips();
  }
}

/* ===== Brand Mapper Q&A (generative) ===== */
async function onMapperQA() {
  const q = $("#mapperQAInput").value.trim();
  const rFrom = $("#mapFrom").value;
  const rTo = $("#mapTo").value;
  const out = $("#mapperQAResult");
  if (!q) {
    out.textContent = "Ask a question first.";
    return;
  }
  out.textContent = "Thinking…";
  try {
    const r = await fetch(`${BACKEND_BASE}/brandmap_qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, region_from: rFrom, region_to: rTo }),
    });
    const data = await r.json();
    const list = (data.matches || [])
      .map(
        (m) =>
          `<li><b>${m.name}</b> (${m.generic}) — ${rFrom}: ${
            m.from.join(", ") || "—"
          } → ${rTo}: ${m.to.join(", ") || "—"}</li>`
      )
      .join("");
    out.innerHTML = `
      <div><b>Mapper AI</b></div>
      ${
        list
          ? `<ul class="list">${list}</ul>`
          : "<div class='muted small'>No exact DB matches; suggested equivalents via AI:</div>"
      }
      <div class="hsep"></div>
      <div>${(data.answer || "").replaceAll("\n", "<br/>")}</div>`;
  } catch (e) {
    out.textContent = "Mapper AI failed. Check backend.";
  }
}

/* ===== Profile Q&A (generative) ===== */
async function onProfileQA() {
  const q = $("#profileQAInput").value.trim();
  const out = $("#profileQAResult");
  if (!q) {
    out.textContent = "Type a question first.";
    return;
  }
  out.textContent = "Thinking…";
  try {
    const r = await fetch(`${BACKEND_BASE}/profile_qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, profile }),
    });
    const data = await r.json();
    out.innerHTML = `<div><b>Profile AI</b></div><div class="hsep"></div><div>${(
      data.answer || ""
    ).replaceAll("\n", "<br/>")}</div>`;
  } catch (e) {
    out.textContent = "Profile AI failed. Check backend.";
  }
}

/* ===== Voice ===== */
function setupVoice() {
  const btn = $("#btnMic");
  let recog = null;
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("no SR");
    recog = new SR();
    recog.lang = "en-IN";
    recog.onresult = (e) => {
      $("#input").value = e.results[0][0].transcript;
      onSend();
    };
    btn.onclick = () => {
      recog.start();
      addBubble("bot", "🎙️ Listening…");
    };
  } catch {
    btn.onclick = () =>
      addBubble("bot", "Voice not supported in this browser.");
  }
}

/* ===== Tabs & Toggles ===== */
function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll(".tab")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tabpanel")
        .forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    };
  });
}
function setupExplainToggle() {
  $("#modeSimple").onclick = () => {
    currentMode = "simple";
    $("#modeSimple").classList.add("active");
    $("#modeDoctor").classList.remove("active");
  };
  $("#modeDoctor").onclick = () => {
    currentMode = "doctor";
    $("#modeDoctor").classList.add("active");
    $("#modeSimple").classList.remove("active");
  };
}

/* ===== INIT ===== */
async function init() {
  $("#btnSend").onclick = onSend;
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSend();
  });
  $("#file").addEventListener("change", onUploadChange);
  $("#btnSettings").onclick = () =>
    $("#settingsModal").classList.remove("hidden");
  $("#btnCloseSettings").onclick = () =>
    $("#settingsModal").classList.add("hidden");
  $("#selLang").onchange = (e) => (profile.lang = e.target.value);
  $("#age").onchange = (e) => (profile.age = Number(e.target.value || 21));
  $("#region").onchange = (e) => {
    profile.region = e.target.value;
    updateRiskRadar();
  };
  $("#allergies").onchange = (e) => {
    profile.allergies = e.target.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    updateRiskRadar();
  };
  $("#hasUlcer").onchange = (e) => {
    profile.ulcer = e.target.checked;
    updateRiskRadar();
  };
  $("#hasLiver").onchange = (e) => {
    profile.liver = e.target.checked;
    updateRiskRadar();
  };
  $("#brandMapper").onchange = (e) => (profile.brandMapper = e.target.checked);
  $("#explainMode").onchange = (e) => (profile.explain = e.target.checked);
  $("#costMode").onchange = (e) => (profile.cost = e.target.checked);
  $("#btnSummarize").onclick = onSummarize;
  $("#btnMap").onclick = mapBrands;
  $("#btnMapperQA").onclick = onMapperQA;
  $("#btnProfileQA").onclick = onProfileQA;

  setupVoice();
  setupTabs();
  setupExplainToggle();

  const resp = await fetch("data/medicineData.json");
  medicineDB = await resp.json();

  addBubble(
    "bot",
    md(
      "Hi! I’m your **Universal Medicine Assistant**. Ask about a drug or describe symptoms. You can also try the **Profile AI** and **Mapper AI** in the right panels."
    )
  );
  renderSelectedChips();
}
document.addEventListener("DOMContentLoaded", init);
