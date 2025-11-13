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

/* ===== REMOVE MARKDOWN (**) ===== */
function stripMarkdown(text) {
  return (text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/\*(.*?)\*/g, "$1");    // italic
}

/* ===== Chat bubbles ===== */
function addBubble(role, html) {
  const outer = document.createElement("div");
  outer.className = "msg-block";
  const bubble = document.createElement("div");
  // keep your original role class naming
  bubble.className = `bubble ${role === "user" ? "user" : "bot"}`;
  bubble.innerHTML = html;
  outer.appendChild(bubble);
  chat.appendChild(outer);
  chat.scrollTop = chat.scrollHeight;
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
    warnings.push("⚠️ Paracetamol caution in liver disease.");

  if (
    ids.includes("amoxiclav") &&
    (profile.allergies || []).map((x) => x.toLowerCase()).includes("penicillin")
  )
    warnings.push("⚠️ Penicillin allergy noted; avoid Amoxicillin/Clav.");

  return warnings;
}

function renderSelectedChips() {
  const wrap = $("#selectedMeds");
  if (!wrap) return;
  wrap.innerHTML = "";
  selectedMeds.forEach((id) => {
    const m = medicineDB.find((x) => x.id === id);
    if (!m) return;
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>💊 ${m.name}</span>`;
    wrap.appendChild(chip);
  });

  const warnings = checkInteractions(
    selectedMeds
      .map((id) => medicineDB.find((m) => m.id === id))
      .filter(Boolean)
  );
  const list = $("#interactionList");
  if (list) {
    list.innerHTML = warnings.length
      ? warnings.map((w) => `<li>${w}</li>`).join("")
      : `<li>No interactions flagged.</li>`;
  }
}

/* ===== Chat (Explain Modes) ===== */
async function onSend() {
  const input = $("#input");
  const q = input.value.trim();
  if (!q) return;
  addBubble("user", q);
  input.value = "";

  if (!USE_BACKEND) {
    addBubble("bot", "Backend disabled.");
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

    // Use delegation-friendly buttons (class chatModeBtn + data-mode)
    const html = `
      <div class="kcard">
        <div class="krow" style="justify-content:space-between; align-items:center;">
          <div><b>Answer</b></div>
          <div class="mode-toggle glass soft">
            <button class="seg chatModeBtn ${currentMode === "simple" ? "active" : ""}" data-mode="simple">Simple</button>
            <button class="seg chatModeBtn ${currentMode === "doctor" ? "active" : ""}" data-mode="doctor">Doctor</button>
          </div>
        </div>
        <div class="krow">
          <div id="ansSimple" style="display:${currentMode === "simple" ? "block" : "none"}">
            ${stripMarkdown(simple).replaceAll("\n","<br/>")}
          </div>
          <div id="ansDoctor" style="display:${currentMode === "doctor" ? "block" : "none"}">
            ${stripMarkdown(doctor).replaceAll("\n","<br/>")}
          </div>
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
  } catch (err) {
    console.error(err);
    addBubble("bot", "API Error.");
  }
}

// ⭐ New: event-delegation handler for chat-card mode buttons.
// This keeps behavior reliable for dynamically added answer cards.
document.addEventListener("click", function (e) {
  const target = e.target;
  // chat card mode buttons have class 'chatModeBtn' and data-mode
  if (target && target.classList && target.classList.contains("chatModeBtn")) {
    const mode = target.getAttribute("data-mode");
    if (!mode) return;

    currentMode = mode; // sync global mode

    // update the clicked card
    const card = target.closest(".kcard");
    if (card) {
      const ansSimple = card.querySelector("#ansSimple");
      const ansDoctor = card.querySelector("#ansDoctor");
      if (ansSimple && ansDoctor) {
        ansSimple.style.display = mode === "simple" ? "block" : "none";
        ansDoctor.style.display = mode === "doctor" ? "block" : "none";
      }
      // highlight only in this card
      const segs = card.querySelectorAll(".chatModeBtn");
      segs.forEach((s) => s.classList.remove("active"));
      target.classList.add("active");
    }

    // update global header buttons visually
    const hs = document.getElementById("modeSimple");
    const hd = document.getElementById("modeDoctor");
    if (hs && hd) {
      if (mode === "simple") {
        hs.classList.add("active");
        hd.classList.remove("active");
      } else {
        hd.classList.add("active");
        hs.classList.remove("active");
      }
    }
  }
});

/* ===== Upload Notice ===== */
function onUploadChange(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  addBubble("user", `Uploaded: ${f.name}`);
  addBubble("bot", "For full analysis, use Report Summarizer →");
}

/* ===== Summarizer ===== */
async function onSummarize() {
  const file = $("#reportFile").files?.[0];
  const status = $("#summarizeStatus");
  if (!file) {
    if (status) status.textContent = "Pick a PDF or image.";
    return;
  }
  if (status) status.textContent = "Analyzing…";

  const fd = new FormData();
  fd.append("file", file);

  try {
    const r = await fetch(`${BACKEND_BASE}/summarize`, {
      method: "POST",
      body: fd,
    });
    const { summary, title, detected_medicines } = await r.json();

    const html = `
      <div class="kcard">
        <div class="krow">
          <div><b>AI Report Summary</b> ${title ? `— ${title}` : ""}</div>
        </div>
        <div class="krow">
          <div>${stripMarkdown(summary).replaceAll("\n","<br/>")}</div>
        </div>
      </div>`;

    addBubble("bot", html);
    if (status) status.textContent = "Done.";

    if (Array.isArray(detected_medicines)) {
      detected_medicines.forEach((name) => {
        const found = searchMedicineLocal(name)[0];
        if (found && !selectedMeds.includes(found.id))
          selectedMeds.push(found.id);
      });
      renderSelectedChips();
    }
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Summarization failed.";
  }
}

/* ===== ONLY AI Brand Mapper (removed JSON-based one) ===== */
async function onMapperQA() {
  const qEl = $("#mapperQAInput");
  const out = $("#mapperQAResult");
  if (!qEl || !out) return;

  const q = qEl.value.trim();
  const rFrom = $("#mapFrom").value;
  const rTo = $("#mapTo").value;

  if (!q) {
    out.textContent = "Type a question.";
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
          `<li><b>${m.name}</b> (${m.generic}) — ${rFrom}: ${m.from.join(
            ", "
          )} → ${rTo}: ${m.to.join(", ")}</li>`
      )
      .join("");

    out.innerHTML = `
      <div><b>Mapper AI</b></div>
      ${
        list
          ? `<ul class="list">${list}</ul>`
          : "<div class='muted small'>No exact DB match — AI suggested equivalents.</div>"
      }
      <div class="hsep"></div>
      <div>${stripMarkdown(data.answer).replaceAll("\n","<br/>")}</div>`;
  } catch (err) {
    console.error(err);
    out.textContent = "Mapper AI failed.";
  }
}

/* ===== Profile AI ===== */
async function onProfileQA() {
  const qEl = $("#profileQAInput");
  const out = $("#profileQAResult");
  if (!qEl || !out) return;

  const q = qEl.value.trim();
  if (!q) {
    out.textContent = "Ask something.";
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
    out.innerHTML = `
      <div><b>Profile AI</b></div>
      <div class="hsep"></div>
      <div>${stripMarkdown(data.answer).replaceAll("\n","<br/>")}</div>`;
  } catch (err) {
    console.error(err);
    out.textContent = "Profile AI failed.";
  }
}

/* ===== Voice ===== */
function setupVoice() {
  const btn = $("#btnMic");
  if (!btn) return;
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
    btn.onclick = () => addBubble("bot", "Voice not supported.");
  }
}

/* ===== Tabs & Toggles ===== */
function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tabpanel").forEach((p) =>
        p.classList.remove("active")
      );
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    };
  });
}

/* ===== Explain Mode (global header) ===== */
function setupExplainToggle() {
  const btnSimple = document.getElementById("modeSimple");
  const btnDoctor = document.getElementById("modeDoctor");

  if (!btnSimple || !btnDoctor) return;

  btnSimple.onclick = () => {
    currentMode = "simple";
    btnSimple.classList.add("active");
    btnDoctor.classList.remove("active");

    // Update the most recent chat card (if present) so the UI matches header
    const cards = document.querySelectorAll(".kcard");
    const last = cards[cards.length - 1];
    if (last) {
      const ansS = last.querySelector("#ansSimple");
      const ansD = last.querySelector("#ansDoctor");
      if (ansS && ansD) {
        ansS.style.display = "block";
        ansD.style.display = "none";
      }
      const segs = last.querySelectorAll(".chatModeBtn");
      if (segs && segs.length) {
        segs.forEach((s) => s.classList.remove("active"));
        segs[0]?.classList.add("active");
      }
    }
  };

  btnDoctor.onclick = () => {
    currentMode = "doctor";
    btnDoctor.classList.add("active");
    btnSimple.classList.remove("active");

    const cards = document.querySelectorAll(".kcard");
    const last = cards[cards.length - 1];
    if (last) {
      const ansS = last.querySelector("#ansSimple");
      const ansD = last.querySelector("#ansDoctor");
      if (ansS && ansD) {
        ansS.style.display = "none";
        ansD.style.display = "block";
      }
      const segs = last.querySelectorAll(".chatModeBtn");
      if (segs && segs.length) {
        segs.forEach((s) => s.classList.remove("active"));
        segs[1]?.classList.add("active");
      }
    }
  };
}

/* ===== INIT ===== */
async function init() {
  const btnSend = $("#btnSend");
  if (btnSend) btnSend.onclick = onSend;

  const inputEl = $("#input");
  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSend();
    });
  }

  const fileEl = $("#file");
  if (fileEl) fileEl.addEventListener("change", onUploadChange);

  const btnSettings = $("#btnSettings");
  if (btnSettings) btnSettings.onclick = () =>
    $("#settingsModal").classList.remove("hidden");
  const btnCloseSettings = $("#btnCloseSettings");
  if (btnCloseSettings) btnCloseSettings.onclick = () =>
    $("#settingsModal").classList.add("hidden");

  const selLang = $("#selLang");
  if (selLang) selLang.onchange = (e) => (profile.lang = e.target.value);
  const age = $("#age");
  if (age) age.onchange = (e) => (profile.age = Number(e.target.value || 21));
  const region = $("#region");
  if (region) region.onchange = (e) => { profile.region = e.target.value; };
  const allergies = $("#allergies");
  if (allergies) allergies.onchange = (e) => {
    profile.allergies = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
  };
  const ulcer = $("#hasUlcer");
  if (ulcer) ulcer.onchange = (e) => (profile.ulcer = e.target.checked);
  const liver = $("#hasLiver");
  if (liver) liver.onchange = (e) => (profile.liver = e.target.checked);

  const btnSumm = $("#btnSummarize");
  if (btnSumm) btnSumm.onclick = onSummarize;
  const btnMapper = $("#btnMapperQA");
  if (btnMapper) btnMapper.onclick = onMapperQA;
  const btnProfileQA = $("#btnProfileQA");
  if (btnProfileQA) btnProfileQA.onclick = onProfileQA;

  setupVoice();
  setupTabs();
  setupExplainToggle();

  try {
    const resp = await fetch("data/medicineData.json");
    medicineDB = await resp.json();
  } catch (err) {
    console.warn("Could not load medicineData.json", err);
    medicineDB = [];
  }

  addBubble(
    "bot",
    "Hi! I'm your <b>Universal Medicine Assistant</b>. Ask anything!"
  );
  renderSelectedChips();
}

document.addEventListener("DOMContentLoaded", init);
