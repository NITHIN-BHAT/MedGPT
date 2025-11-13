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

# ---------------------------------------------------------------------
# ENV + MODEL CONFIG
# ---------------------------------------------------------------------
load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set GOOGLE_API_KEY or GEMINI_API_KEY in .env")

genai.configure(api_key=API_KEY)

# Fastest → slowest fallback
PREFERRED = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
]

def pick_model():
    try:
        models = list(genai.list_models())
        allowed = {}
        for m in models:
            if "generateContent" in getattr(m, "supported_generation_methods", []):
                short = m.name.split("/")[-1]
                allowed[short] = m.name
        for m in PREFERRED:
            if m in allowed:
                return allowed[m]
        return list(allowed.values())[0]
    except:
        return "models/gemini-2.0-flash"

MODEL = pick_model()
print("\n[MedGPT] Using Gemini:", MODEL, "\n")

def model():
    return genai.GenerativeModel(MODEL)

# ---------------------------------------------------------------------
# FASTAPI
# ---------------------------------------------------------------------
app = FastAPI(title="MedGPT Backend Optimized")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# ---------------------------------------------------------------------
# Load medicine DB
# ---------------------------------------------------------------------
HERE = pathlib.Path(__file__).parent.resolve()
DATA = (HERE.parent/"data"/"medicineData.json").resolve()
try:
    MED_DB = json.load(open(DATA, "r", encoding="utf-8"))
except Exception:
    MED_DB = []

ALL_NAMES = []
ID2ROW = {}
for r in MED_DB:
    ID2ROW[r["id"]] = r
    ALL_NAMES.extend([r["name"], r["generic"]])
    for b in r.get("brands", []):
        ALL_NAMES.append(b["brand"])

def fuzzy_find(q):
    if not q.strip(): return []
    res = process.extract(q, ALL_NAMES, scorer=fuzz.WRatio, limit=5)
    return [(x[0], x[1]) for x in res if x[1] >= 60]

def rows_for_name(name):
    n = name.lower()
    result = []
    for r in MED_DB:
        if r["name"].lower() == n or r["generic"].lower() == n:
            result.append(r)
        for b in r.get("brands", []):
            if b["brand"].lower() == n:
                result.append(r)
    return list({r["id"]: r for r in result}.values())

# ---------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------
class AskIn(BaseModel):
    query: str
    profile: Optional[dict] = {}
    mode: Optional[str] = "simple"

class ProfileQAIn(BaseModel):
    question: str
    profile: Optional[dict] = {}

class BrandMapQAIn(BaseModel):
    question: str
    region_from: Optional[str] = "IN"
    region_to: Optional[str] = "US"

# ---------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------
MED_REGEX = re.compile(r"\b([A-Za-z][A-Za-z0-9\- ]{2,30})\b")

def detect_meds(text):
    found = MED_REGEX.findall(text or "")
    return list({m.strip() for m in found if len(m) > 2})[:10]

def run_gemini(parts):
    try:
        return model().generate_content(parts).text or ""
    except Exception as e:
        return f"⚠️ AI failed: {str(e)}"

def extract_pdf_text(pdf_bytes, max_chars=5000):
    out = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        for p in doc:
            out.append(p.get_text("text"))
            if sum(len(x) for x in out) > max_chars:
                break
    return ("\n".join(out))[:max_chars]

def pdf_first_page_small(pdf_bytes, width=600):
    """Small compressed image to avoid 504 timeouts."""
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            if doc.page_count == 0: return None
            p = doc[0]
            pix = p.get_pixmap(matrix=fitz.Matrix(width/72, width/72))
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=40)
        return base64.b64encode(buf.getvalue()).decode()
    except:
        return None

# ---------------------------------------------------------------------
# ENDPOINTS
# ---------------------------------------------------------------------
@app.get("/")
def home():
    return {"status": "ok", "model": MODEL, "meds": len(MED_DB)}

@app.get("/debug/models")
def dbg():
    out=[]
    for m in genai.list_models():
        out.append({"name": m.name, "methods": getattr(m, "supported_generation_methods", [])})
    return {"models": out}

# ASK / CHAT BOT -------------------------------------------------------
@app.post("/ask")
def ask(inp: AskIn):
    profile = inp.profile or {}

    sys_simple = (
        "You are a safe medical explainer. Explain in simple English. "
        "Cover uses, side effects, cautions, cheaper generics, and consider user profile. "
        "End with: 'This is not medical advice.'"
    )
    sys_doctor = (
        "You are a clinician-facing explainer. Cover mechanism, class, doses, AE, "
        "interactions, monitoring. "
        "End with: 'This is not medical advice.'"
    )

    user = f"User Query: {inp.query}\nProfile: {profile}"

    simple = run_gemini([sys_simple, user])
    doctor = run_gemini([sys_doctor, user])
    meds = list({*detect_meds(simple), *detect_meds(doctor)})

    return {"simple": simple, "doctor": doctor, "detected_medicines": meds}

# PROFILE Q&A ----------------------------------------------------------
@app.post("/profile_qa")
def profile_qa(inp: ProfileQAIn):
    sys = (
        "You are a medical assistant. Use user profile (age, allergy, ulcer, liver). "
        "Explain safely. End with: 'This is not medical advice.'"
    )
    user = f"Q: {inp.question}\nProfile: {inp.profile}"
    out = run_gemini([sys, user])
    return {"answer": out}

# BRAND MAP Q&A --------------------------------------------------------
@app.post("/brandmap_qa")
def brandmap_qa(inp: BrandMapQAIn):
    q = inp.question.strip()
    r1 = inp.region_from.upper()
    r2 = inp.region_to.upper()

    cand = fuzzy_find(q)
    rows = []
    for name,_ in cand:
        rows.extend(rows_for_name(name))

    rows = list({r["id"]: r for r in rows}.values())

    mapping = []
    for r in rows:
        from_br = [b["brand"] for b in r.get("brands", []) if b["region"].upper() in (r1, "GLOBAL")]
        to_br   = [b["brand"] for b in r.get("brands", []) if b["region"].upper() in (r2, "GLOBAL")]
        mapping.append({
            "name": r["name"],
            "generic": r["generic"],
            "class": r.get("class",""),
            "from": from_br,
            "to": to_br
        })

    sys = "You are a drug brand mapper. Compare global equivalents safely."
    user = f"Query: {q}\nFrom: {r1} To: {r2}\nMapping: {json.dumps(mapping)}"

    out = run_gemini([sys, user])
    return {"mapping": mapping, "answer": out}

# SUMMARIZER -----------------------------------------------------------
@app.post("/summarize")
async def summarize(file: UploadFile = File(...)):
    data = await file.read()
    mime = file.content_type or ""

    sys = (
        "You summarize medical reports concisely. Include: title, key findings, "
        "diagnoses/values, meds mentioned, risks, 2-line TLDR. "
        "End with: 'This is not medical advice.'"
    )

    # --------------------- PDF ---------------------
    if mime.startswith("application/pdf"):
        # small text extract only
        text = extract_pdf_text(data, max_chars=5000)

        # ultra-light image embed (optional)
        img_b64 = pdf_first_page_small(data, width=500)

        parts = [sys, "Summarize this PDF report."]
        if img_b64:
            parts.append({"mime_type": "image/jpeg", "data": base64.b64decode(img_b64)})

        parts.append(f"Extracted text:\n{text}")

        summary = run_gemini(parts)
        meds = detect_meds(text + "\n" + summary)
        title = (text.splitlines()[0] if text else "").strip()

        return {"summary": summary, "title": title, "detected_medicines": meds}

    # --------------------- IMAGE ---------------------
    if mime.startswith("image/"):
        parts = [sys, "Summarize this medical image report:", {"mime_type": mime, "data": data}]
        summary = run_gemini(parts)
        meds = detect_meds(summary)
        return {"summary": summary, "title": file.filename, "detected_medicines": meds}

    # --------------------- TEXT ---------------------
    try:
        text = data.decode("utf-8", errors="ignore")
    except:
        text = ""

    text = text[:5000]
    summary = run_gemini([sys, text])
    meds = detect_meds(text + "\n" + summary)
    return {"summary": summary, "title": file.filename, "detected_medicines": meds}
