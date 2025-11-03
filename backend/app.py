import base64, io, os, re, json, traceback, pathlib
from typing import Optional, List, Dict, Any
import fitz  # PyMuPDF
from PIL import Image
from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from rapidfuzz import process, fuzz

# -----------------------------------------------------------------------------
# Config & setup
# -----------------------------------------------------------------------------
load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GOOGLE_API_KEY (or GEMINI_API_KEY) in backend/.env")
genai.configure(api_key=API_KEY)

PREFERRED = ["gemini-2.5-flash","gemini-2.5-pro","gemini-2.0-flash","gemini-1.5-flash-8b","gemini-1.5-flash","gemini-1.0-pro"]

def pick_model() -> str:
    try:
        models = list(genai.list_models())
        avail_full = [m.name for m in models if "generateContent" in getattr(m, "supported_generation_methods", [])]
        short_to_full = {name.split("/")[-1]: name for name in avail_full}
        for want in PREFERRED:
            if want in short_to_full: return short_to_full[want]
        return avail_full[0]
    except Exception:
        return "models/gemini-2.5-flash"

MODEL_FULL_NAME = pick_model()
print(f"[MedGPT] Using Gemini model: {MODEL_FULL_NAME}")
def _model(): return genai.GenerativeModel(MODEL_FULL_NAME)

app = FastAPI(title="MedGPT Backend (Fully Generative Panels)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# -----------------------------------------------------------------------------
# Load local medicine DB for brand mapping & heuristics
# -----------------------------------------------------------------------------
HERE = pathlib.Path(__file__).parent.resolve()
DATA_PATH = (HERE.parent / "data" / "medicineData.json").resolve()
try:
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        MED_DB = json.load(f)
except Exception as e:
    print("[MedGPT] Could not load medicineData.json:", e)
    MED_DB = []

# Build searchable lists
ALL_NAMES = []
ID2ROW: Dict[str, Dict[str, Any]] = {}
for row in MED_DB:
    ID2ROW[row["id"]] = row
    ALL_NAMES.append(row["name"])
    ALL_NAMES.append(row["generic"])
    for b in row.get("brands", []):
        ALL_NAMES.append(b["brand"])

def fuzzy_find(query: str, limit=5):
    # returns list of (matched_name, score)
    q = (query or "").strip()
    if not q: return []
    matches = process.extract(q, ALL_NAMES, scorer=fuzz.WRatio, limit=limit)
    return [(m[0], m[1]) for m in matches if m[1] >= 60]  # threshold

def rows_for_name(name: str):
    name_low = (name or "").lower()
    out = []
    for r in MED_DB:
        if r["name"].lower() == name_low or r["generic"].lower() == name_low:
            out.append(r); continue
        for b in r.get("brands", []):
            if b["brand"].lower() == name_low:
                out.append(r); break
    # de-dup by id
    uniq = {r["id"]: r for r in out}
    return list(uniq.values())

# -----------------------------------------------------------------------------
# Schemas
# -----------------------------------------------------------------------------
class AskIn(BaseModel):
    query: str
    profile: Optional[dict] = None
    mode: Optional[str] = "simple"

class ProfileQAIn(BaseModel):
    question: str
    profile: Optional[dict] = None

class BrandMapQAIn(BaseModel):
    question: str
    region_from: Optional[str] = None
    region_to: Optional[str] = None

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
MED_NAME_REGEX = re.compile(r"\b([A-Z][a-z]+(?:[ -][A-Z][a-z]+)*\s?\d{0,4}\s?(?:mg|ML|ml)?)\b")
def detect_meds_in_text(text: str, limit=8) -> List[str]:
    cand = MED_NAME_REGEX.findall(text or ""); out=[]
    for c in cand:
        c=c.strip()
        if 2 < len(c) <= 40 and c not in out: out.append(c)
        if len(out) >= limit: break
    return out

def gen(parts) -> str:
    try:
        return _model().generate_content(parts).text or ""
    except Exception as e:
        traceback.print_exc()
        return f"Sorry, the AI request failed: {e}"

def _pdf_text(pdf_bytes: bytes, max_chars: int = 8000) -> str:
    out=[]
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        for p in doc:
            out.append(p.get_text("text"))
            if sum(len(t) for t in out) > max_chars: break
    return ("\n".join(out))[:max_chars]

def _pdf_first_page_png_b64(pdf_bytes: bytes, width: int = 1400) -> str | None:
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.page_count == 0: return None
        page = doc[0]; pix = page.get_pixmap(matrix=fitz.Matrix(width/72, width/72))
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    buf = io.BytesIO(); img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------
@app.get("/")
def root():
    return {"ok": True, "model": MODEL_FULL_NAME, "medCount": len(MED_DB)}

@app.get("/debug/models")
def debug_models():
    out=[]
    for m in genai.list_models():
        out.append({"name": m.name, "methods": getattr(m, "supported_generation_methods", [])})
    return {"models": out}

# ---- Existing Chat (Simple & Doctor) ----
@app.post("/ask")
def ask(payload: AskIn):
    prof = payload.profile or {}
    sys_simple = (
        "You are a medical information assistant for educational purposes only. "
        "Explain in plain, simple language with short sentences. Include: uses, common side effects, key cautions "
        "based on the user's profile (ulcer -> avoid NSAIDs; liver disease -> paracetamol caution), and a cheaper generic if applicable. "
        "End with: 'This is not medical advice.'"
    )
    sys_doctor = (
        "You are a clinician-facing pharmacology explainer. Use concise, professional language. "
        "Include: mechanism/class, indications with dose ranges if typical, contraindications, adverse effects (common/serious), "
        "relevant interactions, monitoring, and cost-effective generic options. "
        "End with: 'This is not medical advice.'"
    )
    user = f"User query: {payload.query}\nUser profile: {prof}\nRegion: {prof.get('region','IN')}"
    simple = gen([sys_simple, user])
    doctor = gen([sys_doctor, user])
    detected = list({*detect_meds_in_text(simple), *detect_meds_in_text(doctor)})
    return {"simple": simple, "doctor": doctor, "detected_medicines": detected}

# ---- Generative Profile Q&A ----
@app.post("/profile_qa")
def profile_qa(payload: ProfileQAIn):
    prof = payload.profile or {}
    sys = (
        "You are a cautious medical assistant for educational purposes. "
        "Answer the user's question using their health profile (age, allergies, ulcer/liver history, region). "
        "Be specific to their risks, mention if data is insufficient, and suggest safer alternatives when possible. "
        "End with: 'This is not medical advice.'"
    )
    user = f"User question: {payload.question}\nUser profile: {prof}"
    answer = gen([sys, user])
    return {"answer": answer}

# ---- Generative Brand Mapper Q&A (with data + LLM) ----
@app.post("/brandmap_qa")
def brandmap_qa(payload: BrandMapQAIn):
    q = (payload.question or "").strip()
    r_from = (payload.region_from or "").upper() or "IN"
    r_to = (payload.region_to or "").upper() or "US"

    # 1) Fuzzy detect what drug/brand they asked
    candidates = fuzzy_find(q, limit=5)  # [(name, score), ...]
    matched_rows = []
    for name,_ in candidates:
        matched_rows += rows_for_name(name)
    # de-dup by id
    uniq = {r["id"]: r for r in matched_rows}
    matched_rows = list(uniq.values())

    # 2) Build mapping table from DB
    mapping = []
    for r in matched_rows:
        from_names = [b["brand"] for b in r.get("brands", []) if b.get("region","").upper() in (r_from, "GLOBAL")]
        to_names   = [b["brand"] for b in r.get("brands", []) if b.get("region","").upper() in (r_to, "GLOBAL")]
        mapping.append({
            "id": r["id"], "name": r["name"], "generic": r["generic"], "class": r.get("class",""),
            "from": from_names, "to": to_names
        })

    # 3) Ask LLM to reason + fill if DB is sparse (also handles nutraceuticals/herbals)
    sys = (
        "You are a medicine brand equivalence mapper for different regions. "
        "Given the user's free-text question and a mapping table (may be partial), "
        "produce a concise mapping: key generic, notable brand names in region A and region B, and cautions on equivalence. "
        "If no direct brand is known, suggest same-generic equivalents. "
        "End with: 'This is not medical advice.'"
    )
    user = f"Question: {q}\nFrom region: {r_from}\nTo region: {r_to}\nLocal mapping data: {json.dumps(mapping)[:6000]}"
    answer = gen([sys, user])

    # 4) Return both the structured hits and the generative explanation
    return {"matches": mapping, "answer": answer, "regions": {"from": r_from, "to": r_to}}
    
# ---- Report Summarizer (unchanged) ----
@app.post("/summarize")
async def summarize(file: UploadFile = File(...)):
    content = await file.read()
    mime = file.content_type or ""
    sys = (
        "You are a medical report summarizer for educational purposes. "
        "Return a short, plain-language summary with: 1) Title (if present) 2) Key findings "
        "3) Any diagnoses/values with units 4) Mentioned medicines and purposes 5) Risks/contraindications/interactions "
        "6) TL;DR in 2 lines. End with: 'This is not medical advice.'"
    )

    if mime.startswith("application/pdf"):
        text = _pdf_text(content, 9000)
        img_b64 = _pdf_first_page_png_b64(content)
        parts = [sys, "Summarize this medical PDF (first page image + extracted text)."]
        if img_b64: parts.append({"mime_type":"image/png","data":base64.b64decode(img_b64)})
        parts.append(f"Extracted text (OCR may be imperfect):\n{text[:9000]}")
        summary = gen(parts)
        detected = detect_meds_in_text(text + "\n" + summary)
        title = next((line.strip() for line in text.splitlines() if 4 < len(line) < 120), None)
        return {"summary": summary, "title": title, "detected_medicines": detected}

    elif mime.startswith("image/"):
        parts = [sys, "Summarize this medical image/report:", {"mime_type": mime, "data": content}]
        summary = gen(parts)
        detected = detect_meds_in_text(summary)
        return {"summary": summary, "title": file.filename, "detected_medicines": detected}

    else:
        text = content.decode("utf-8", errors="ignore")
        summary = gen([sys, text[:9000]])
        detected = detect_meds_in_text(text + "\n" + summary)
        return {"summary": summary, "title": file.filename, "detected_medicines": detected}
